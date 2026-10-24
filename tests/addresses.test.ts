import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { AutochargingService } from '../src/autocharging.js';
import { createBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { parseReserveAmount } from '../src/money.js';
import { Notifier } from '../src/notifier.js';
import { bootstrapUsers, getSubscription, getUsage, listSubscriptions } from '../src/repository.js';
import { getReportData, markdownReport, quickReport, reportTotals } from '../src/reports.js';
import { SohuApiError, SohuClient } from '../src/sohu.js';
import type { SmartOrder } from '../src/types.js';
import { testDatabase } from './db-helper.js';

const addressA='TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const addressB='T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const config=loadConfig({BOT_TOKEN:'test-bot-token',ALLOWED_USER_ID:'101',ADMIN_USER_ID:'202',DATABASE_URL:'postgresql://localhost/test',SOHU_API_KEY:'test',SOHU_API_SECRET:'test',NODE_ENV:'test',LOG_LEVEL:'silent'});
const logger=createLogger(config);
const envelope=<T>(data:T)=>({code:1,msg:'ok',time:'0',data});

class Provider {
  states=new Map<string,{balance:string;status:'start'|'stop';orders:SmartOrder[]}>();
  getSmartPrice=vi.fn(async()=>envelope({high_frequency:{'65k_price':'1.7','131K_price':'3.4'}}));
  getUserInfo=vi.fn(async()=>envelope({balance_trx:'1000',balance_usdt:'0'}));
  getStatistics=vi.fn(async()=>envelope({}));
  queryEnergy=vi.fn(async(address:string)=>{
    const state=this.states.get(address);
    if (!state) throw new SohuApiError('Not found',404);
    return envelope({address,balance:state.balance,status:state.status,page:1,page_size:1000,order_count:state.orders.length,orders:state.orders});
  });
  delegateEnergy=vi.fn(async({address,balanceTrx}:{address:string;balanceTrx:string})=>{
    const old=this.states.get(address);
    const state={balance:balanceTrx,status:'start' as const,orders:old?.orders??[]};
    this.states.set(address,state);
    return envelope({address,...state});
  });
  updateEnergy=vi.fn(async(address:string,status:'start'|'stop')=>{
    const state=this.states.get(address)!;
    state.status=status;
    return envelope({address,...state});
  });
  topUpEnergy=vi.fn(async(address:string,amount:string)=>{
    const state=this.states.get(address)!;
    state.balance=String(Number(state.balance)+Number(amount));
    return envelope({address,...state});
  });
}

const order=(id:number,used=64285):SmartOrder=>({used_tx_id:id.toString(16).padStart(64,'0'),delegate_tx_id:('d'+id).padStart(64,'0'),energy_type:'131k',delegate_count:131000,used_energy:used,amount:'1.7',currency:'trx',status:'un_delegate_success',createtime:Math.floor(Date.now()/1000)});

describe('multi-address reserves on PostgreSQL',()=>{
  let db:Db;
  let provider:Provider;
  let service:AutochargingService;
  beforeAll(async()=>{db=(await testDatabase()).pool;},30000);
  afterAll(async()=>db?.end());
  beforeEach(async()=>{
    await db.query('TRUNCATE notification_outbox,provider_order_baselines,provider_credit_topups,ledger_entries,provider_usage_events,autocharging_cycles,autocharging_subscriptions,app_users,audit_events,price_snapshots,telegram_event_logs RESTART IDENTITY CASCADE');
    await bootstrapUsers(db,101n,202n);
    provider=new Provider();
    service=new AutochargingService(db,provider as unknown as SohuClient,config,logger);
  });

  it('isolates reserves and makes a top-up additive and idempotent',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'init-a');
    const b=await service.connect(101n,addressB,25_000_000n,'init-b');
    provider.topUpEnergy.mockClear();
    await service.addReserve(101n,a.id,1_000_000_000n,'topup-a');
    await service.addReserve(101n,a.id,1_000_000_000n,'topup-a');
    expect((await getSubscription(db,101n,a.id))?.reserve_balance_micros).toBe('1100000000');
    expect((await getSubscription(db,101n,b.id))?.reserve_balance_micros).toBe('25000000');
    expect(provider.topUpEnergy).not.toHaveBeenCalled();
    expect((await getReportData(db,101n,a.id)).ledger.map(row=>row.kind)).toEqual(['reserve_topup','reserve_topup']);
  });

  it('allows a zero starting reserve without funding Sohu',async()=>{
    const a=await service.connect(101n,addressA,0n,'zero');
    expect(a.status).toBe('low_balance');
    expect(provider.delegateEnergy).not.toHaveBeenCalled();
    await service.addReserve(101n,a.id,10_000_000n,'fund');
    await service.changeState(101n,a.id,'resume');
    expect((await getSubscription(db,101n,a.id))?.status).toBe('active');
  });

  it('accounts shared transaction hashes independently for two addresses and never charges twice',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    const b=await service.connect(101n,addressB,200_000_000n,'b');
    provider.states.get(addressA)!.orders=[order(1)];
    provider.states.get(addressB)!.orders=[order(1)];
    await service.syncAll();
    await service.syncAll();
    expect((await getSubscription(db,101n,a.id))?.reserve_balance_micros).toBe('98000000');
    expect((await getSubscription(db,101n,b.id))?.reserve_balance_micros).toBe('198000000');
    expect(await getUsage(db,a.id)).toHaveLength(1);
    expect(await getUsage(db,b.id)).toHaveLength(1);
  });

  it('warns once, rearms after a top-up, and does not resend to the user if admin delivery fails',async()=>{
    const a=await service.connect(101n,addressA,20_000_000n,'a');
    provider.states.get(addressA)!.orders=[order(1,130000),order(2,130000),order(3,130000)];
    await service.syncAll();
    await service.syncAll();
    const warnings=await db.query("SELECT text FROM notification_outbox WHERE text LIKE '⚠️ Заканчивается%'");
    expect(warnings.rows).toHaveLength(1);
    expect(warnings.rows[0].text).toContain(addressA);
    const delivered=vi.fn(async(_n:unknown,recipient:string)=>recipient==='user');
    await service.deliverNotifications(delivered);
    const userCalls=delivered.mock.calls.filter(call=>call[1]==='user').length;
    await service.deliverNotifications(delivered);
    expect(delivered.mock.calls.filter(call=>call[1]==='user')).toHaveLength(userCalls);
    await service.addReserve(101n,a.id,100_000_000n,'refill');
    expect((await getSubscription(db,101n,a.id))?.low_balance_notified).toBe(false);
  });

  it('pauses only the depleted address and processes late usage even below zero',async()=>{
    const a=await service.connect(101n,addressA,4_000_000n,'a');
    const b=await service.connect(101n,addressB,100_000_000n,'b');
    provider.states.get(addressA)!.orders=[order(1,130000)];
    await service.syncAll();
    expect((await getSubscription(db,101n,a.id))?.status).toBe('paused');
    expect((await getSubscription(db,101n,b.id))?.status).toBe('active');
    provider.states.get(addressA)!.orders.push(order(2,130000));
    await service.syncAll();
    await service.syncAll();
    expect((await getSubscription(db,101n,a.id))?.reserve_balance_micros).toBe('-3400000');
    expect(await getUsage(db,a.id)).toHaveLength(2);
  });

  it('preserves a disabled address, hides a deleted one and does not rebill history on re-add',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    provider.states.get(addressA)!.orders=[order(1)];
    await service.syncAll();
    await service.changeState(101n,a.id,'disable');
    expect(await listSubscriptions(db,101n)).toHaveLength(1);
    await service.changeState(101n,a.id,'resume');
    await service.remove(101n,a.id);
    expect(await listSubscriptions(db,101n)).toHaveLength(0);
    const fresh=await service.connect(101n,addressA,50_000_000n,'fresh');
    await service.syncAll();
    expect((await getSubscription(db,101n,fresh.id))?.reserve_balance_micros).toBe('50000000');
    expect(await getUsage(db,fresh.id)).toHaveLength(0);
  });

  it('produces ten recent operations and a complete address-specific Markdown report',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    await service.connect(101n,addressB,100_000_000n,'b');
    provider.states.get(addressA)!.orders=Array.from({length:12},(_,i)=>order(i+1));
    provider.states.get(addressB)!.orders=[order(99)];
    await service.syncAll();
    const data=await getReportData(db,101n,a.id);
    expect(reportTotals(data).count).toBe(12);
    expect(reportTotals(data).net).toBe(24_000_000n);
    expect(quickReport(data).match(/возврат \+/g)).toHaveLength(10);
    const report=markdownReport(data);
    expect(report.match(/https:\/\/tronscan/g)).toHaveLength(12);
    expect(report).not.toContain(addressB);
    expect(report).toContain('Начальный виртуальный резерв');
  });

  it('blocks admin mutations in the service and through forged inline callbacks',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    await expect(service.addReserve(202n,a.id,100n,'attack')).rejects.toThrow('только владелец');
    await expect(service.changeState(202n,a.id,'pause')).rejects.toThrow('только владелец');
    const {bot}=createBot(config,db,service,created=>new Notifier(created,db,101n,202n,logger),logger);
    bot.api.config.use(async(_previous,method)=>({ok:true,result:method==='getMe'?{id:999,is_bot:true,first_name:'Test',username:'test_bot'}:{message_id:1,date:0,chat:{id:202,type:'private'}}}));
    await bot.init();
    for (const data of ['add',`topup:${a.id}`,`do:pause:${a.id}`,`do:delete:${a.id}`]) {
      await bot.handleUpdate({update_id:Math.floor(Math.random()*100000),callback_query:{id:'q',chat_instance:'c',from:{id:202,is_bot:false,first_name:'Admin'},data,message:{message_id:1,date:0,chat:{id:202,type:'private'},text:'Menu'}}});
    }
    expect((await getSubscription(db,101n,a.id))?.status).toBe('active');
    expect(provider.updateEnergy).not.toHaveBeenCalled();
  });

  it('sends hf_deposit=0 only for initial connection and omits it for technical top-ups',async()=>{
    const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify(envelope({address:addressA,balance:'20',status:'start'})),{status:200}));
    try {
      const client=new SohuClient(config,db);
      await client.delegateEnergy({address:addressA,balanceTrx:'20'});
      await client.topUpEnergy(addressA,'10');
      const first=new URLSearchParams(fetchMock.mock.calls[0]![1]?.body as URLSearchParams);
      const second=new URLSearchParams(fetchMock.mock.calls[1]![1]?.body as URLSearchParams);
      expect(first.get('hf_deposit')).toBe('0');
      expect(second.has('hf_deposit')).toBe(false);
    } finally {fetchMock.mockRestore();}
  });

  it('sizes each technical top-up against its own reserve',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    const b=await service.connect(101n,addressB,5_000_000n,'b');
    provider.states.get(addressA)!.balance='1';
    provider.states.get(addressB)!.balance='1';
    await service.syncAll();
    expect(provider.topUpEnergy).toHaveBeenCalledWith(addressA,'20');
    expect(provider.topUpEnergy).toHaveBeenCalledWith(addressB,'3.7');
    expect((await getSubscription(db,101n,a.id))?.reserve_balance_micros).toBe('100000000');
    expect((await getSubscription(db,101n,b.id))?.reserve_balance_micros).toBe('5000000');
  });

  it('blocks repeated funding after an ambiguous timeout, including after a restart',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    provider.states.get(addressA)!.balance='1';
    provider.topUpEnergy.mockRejectedValue(new Error('timeout'));
    await service.syncAll();
    const restarted=new AutochargingService(db,provider as unknown as SohuClient,config,logger);
    await restarted.syncAll();
    expect(provider.topUpEnergy).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT status FROM provider_credit_topups')).rows[0].status).toBe('uncertain');
    expect((await getSubscription(db,101n,a.id))?.status).toBe('paused');
    await expect(service.changeState(101n,a.id,'resume')).rejects.toThrow('неподтверждённое пополнение');
  });

  it('keeps the address visible if Sohu does not confirm deletion stop',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    provider.updateEnergy.mockRejectedValue(new Error('connection lost'));
    await expect(service.remove(101n,a.id)).rejects.toThrow('connection lost');
    expect(await listSubscriptions(db,101n)).toHaveLength(1);
  });

  it('pauses instead of repeating a recent top-up when Sohu credit is unexpectedly empty',async()=>{
    const a=await service.connect(101n,addressA,100_000_000n,'a');
    provider.states.get(addressA)!.balance='1';
    await service.syncAll();
    expect(provider.topUpEnergy).toHaveBeenCalledTimes(1);
    provider.states.get(addressA)!.balance='0';
    await service.syncAll();
    expect(provider.topUpEnergy).toHaveBeenCalledTimes(1);
    expect((await getSubscription(db,101n,a.id))?.status).toBe('paused');
  });
});

it('migrates a legacy address to a hidden record and permits multiple new addresses',async()=>{
  const {engine,pool}=await testDatabase(['001_initial.sql','002_provider_credit_topups.sql']);
  try {
    await pool.query("INSERT INTO app_users(telegram_id,role) VALUES (101,'user')");
    await pool.query("INSERT INTO autocharging_subscriptions(user_telegram_id,tron_address,status,souhu_status,deposit_micros,minimum_energy_72h) VALUES (101,$1,'active','start',15000000,460000)",[addressA]);
    await engine.exec(await readFile(new URL('../migrations/003_multiple_address_reserves.sql',import.meta.url),'utf8'));
    const legacy=(await pool.query('SELECT * FROM autocharging_subscriptions')).rows[0];
    expect(legacy.deleted_at).toBeTruthy();
    expect(legacy.provider_stop_pending).toBe(true);
    expect(await listSubscriptions(pool,101n)).toHaveLength(0);
    for (const address of [addressA,addressB]) await pool.query("INSERT INTO autocharging_subscriptions(user_telegram_id,tron_address,status,minimum_energy_72h) VALUES (101,$1,'paused',460000)",[address]);
    expect(await listSubscriptions(pool,101n)).toHaveLength(2);
  } finally {await pool.end();}
},30000);

it('parses arbitrary virtual reserves exactly without rounding away user input',()=>{
  expect(parseReserveAmount('1 000,123456')).toBe(1_000_123456n);
  expect(parseReserveAmount('0',true)).toBe(0n);
  expect(parseReserveAmount('99999999999999999999999999999999')).toBe(99999999999999999999999999999999_000000n);
  expect(()=>parseReserveAmount('-1')).toThrow();
  expect(()=>parseReserveAmount('0')).toThrow();
  expect(()=>parseReserveAmount('1.0000001')).toThrow();
});
