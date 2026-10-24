import { Bot, InlineKeyboard, InputFile, type Context, GrammyError } from 'grammy';
import type { AutochargingService } from './autocharging.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Logger } from './logger.js';
import { microsToTrx, parseReserveAmount, trxToMicros } from './money.js';
import type { Notifier } from './notifier.js';
import { getLatestPrices, getSubscription, listSubscriptions, logAudit, logTelegramEvent } from './repository.js';
import { getReportData, markdownReport, quickReport, reportDate, statusLabels } from './reports.js';
import { isValidTronAddress } from './tron.js';

type Flow =
  | {step:'address';expires:number}
  | {step:'initial';address:string;expires:number}
  | {step:'topup';id:string;expires:number};
const PER_PAGE=8;
const icon: Record<string,string>={active:'🟢',paused:'⏸',disabled:'⛔',low_balance:'🟡',pending:'⌛',error:'⚠️'};

export function createBot(config: Config,db: Db,service: AutochargingService,notifierFactory:(bot:Bot)=>Notifier,logger:Logger) {
  const bot=new Bot(config.BOT_TOKEN);
  const notifier=notifierFactory(bot);
  const flows=new Map<number,Flow>();
  const isUser=(ctx:Context)=>ctx.from?.id.toString()===config.ALLOWED_USER_ID.toString();
  const isAdmin=(ctx:Context)=>ctx.from?.id.toString()===config.ADMIN_USER_ID.toString();

  bot.use(async (ctx,next) => {
    await logTelegramEvent(db,{updateId:ctx.update.update_id,userId:ctx.from?BigInt(ctx.from.id):undefined,direction:'in',eventType:'update',payload:ctx.update});
    if (!isUser(ctx)&&!isAdmin(ctx)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({text:'Доступ запрещён'});
      else await ctx.reply('Доступ запрещён.');
      return;
    }
    if (ctx.chat?.type!=='private') {
      await ctx.reply('Управление адресами доступно в личном чате с ботом.');
      return;
    }
    await next();
  });

  async function screen(ctx:Context,text:string,keyboard?:InlineKeyboard) {
    await logTelegramEvent(db,{userId:BigInt(ctx.from!.id),direction:'out',eventType:'screen',payload:{text}});
    const options={reply_markup:keyboard};
    if (ctx.callbackQuery?.message) {
      try { await ctx.editMessageText(text,options); return; }
      catch (error) {
        if (error instanceof GrammyError && error.description.includes('message is not modified')) return;
        if (!(error instanceof GrammyError)) throw error;
      }
    }
    await ctx.reply(text,options);
  }

  async function mutationAllowed(ctx:Context):Promise<boolean> {
    if (isUser(ctx)) return true;
    await ctx.reply('👁 Администратору доступен только просмотр.');
    return false;
  }

  async function addressList(ctx:Context,page=0) {
    flows.delete(ctx.from!.id);
    const rows=await listSubscriptions(db,config.ALLOWED_USER_ID);
    const pages=Math.max(1,Math.ceil(rows.length/PER_PAGE));
    page=Math.max(0,Math.min(page,pages-1));
    const keyboard=new InlineKeyboard();
    for (const row of rows.slice(page*PER_PAGE,(page+1)*PER_PAGE)) {
      keyboard.text(`${icon[row.status]??'⚪'} #${row.id} ${row.tron_address.slice(0,6)}…${row.tron_address.slice(-5)} · ${microsToTrx(BigInt(row.reserve_balance_micros))} TRX`,`a:${row.id}`).row();
    }
    if (page>0) keyboard.text('←',`list:${page-1}`);
    if (page+1<pages) keyboard.text('→',`list:${page+1}`);
    keyboard.row().text('➕ Добавить адрес','add');
    const sum=rows.reduce((total,row)=>total+BigInt(row.reserve_balance_micros),0n);
    await screen(ctx,`⚡ Автозаряд Pro\n\nАдресов: ${rows.length}. Сумма резервов: ${microsToTrx(sum)} TRX.\n${rows.length?'Выберите адрес.':'Добавьте адрес и задайте его виртуальный резерв.'}\nРезерв каждого адреса пополняется отдельно.${pages>1?`\nСтраница ${page+1} / ${pages}`:''}${isAdmin(ctx)?'\n\n👁 Режим администратора: просмотр.':''}`,keyboard);
  }

  async function requireVisible(id:string) {
    const row=await getSubscription(db,config.ALLOWED_USER_ID,id);
    if (!row) throw new Error('Адрес удалён или не найден. Откройте список адресов.');
    return row;
  }

  async function addressCard(ctx:Context,id:string) {
    flows.delete(ctx.from!.id);
    const row=await requireVisible(id);
    const prices=await getLatestPrices(db);
    const fee=trxToMicros(config.SERVICE_FEE_TRX);
    const priceText=prices?`\n65K — ${microsToTrx(prices.price65Micros+fee)} TRX; 131K — ${microsToTrx(prices.price131Micros+fee)} TRX (с комиссией).`:'';
    const keyboard=new InlineKeyboard().text('💰 Пополнить депозит',`topup:${id}`).row();
    if (row.status==='active') keyboard.text('⏸ Пауза',`do:pause:${id}`);
    if (['paused','disabled','low_balance'].includes(row.status)) keyboard.text('▶️ Включить',`do:resume:${id}`);
    if (!['disabled','pending'].includes(row.status)) keyboard.text('⛔ Отключить',`ask:disable:${id}`);
    keyboard.row().text('📊 Последние 10',`stats:${id}`).text('📄 Полный MD',`report:${id}`);
    keyboard.row().text('🗑 Удалить из списка',`ask:delete:${id}`);
    keyboard.row().text('🔄 Обновить',`a:${id}`).text('← Все адреса','list:0');
    await screen(ctx,`⚡ Автозаряд Pro · #${id}\n${row.tron_address}\n\nСтатус: ${statusLabels[row.status]??row.status}\nРезерв (депозит): ${microsToTrx(BigInt(row.reserve_balance_micros))} TRX${priceText}\n\nПополнение добавляет любую указанную сумму к резерву этого адреса.\nПоследняя синхронизация: ${reportDate(row.last_souhu_sync_at)} МСК${row.last_error?`\nПричина: ${row.last_error}`:''}`,keyboard);
  }

  async function flush() {
    await service.deliverNotifications(async (n,recipient) => {
      const buttons=new InlineKeyboard().text('💰 Пополнить',`topup:${n.subscriptionId}`).text('Открыть адрес',`a:${n.subscriptionId}`);
      const admin=recipient==='admin';
      return notifier.send(admin?config.ADMIN_USER_ID:config.ALLOWED_USER_ID,(admin?'👁 Уведомление пользователя\n\n':'')+n.text,{reply_markup:buttons});
    });
  }

  bot.command(['start','menu','cancel'],async (ctx)=>addressList(ctx));

  bot.callbackQuery(/^(?:list:(\d+)|menu|autopay|balance)$/,async (ctx)=>{
    await ctx.answerCallbackQuery();
    await addressList(ctx,Number(ctx.match[1]??0));
  });

  bot.callbackQuery(/^a:(\d+)$/,async (ctx)=>{
    await ctx.answerCallbackQuery();
    await addressCard(ctx,ctx.match[1]!);
  });

  bot.callbackQuery(['add','connect'],async (ctx)=>{
    await ctx.answerCallbackQuery();
    if (!await mutationAllowed(ctx)) return;
    flows.set(ctx.from.id,{step:'address',expires:Date.now()+30*60*1000});
    await screen(ctx,'➕ Добавление адреса\n\nОтправьте публичный TRON-адрес, начинающийся с T.',new InlineKeyboard().text('Отмена','list:0'));
  });

  bot.callbackQuery(/^topup:(\d+)$/,async (ctx)=>{
    await ctx.answerCallbackQuery();
    if (!await mutationAllowed(ctx)) return;
    const row=await requireVisible(ctx.match[1]!);
    flows.set(ctx.from.id,{step:'topup',id:row.id,expires:Date.now()+30*60*1000});
    await screen(ctx,`💰 Пополнение депозита\n${row.tron_address}\nТекущий резерв: ${microsToTrx(BigInt(row.reserve_balance_micros))} TRX.\n\nВведите сумму TRX, которую нужно добавить. Это виртуальный лимит; переводить деньги не требуется.`,new InlineKeyboard().text('Отмена',`a:${row.id}`));
  });

  bot.callbackQuery(/^ask:(disable|delete):(\d+)$/,async (ctx)=>{
    await ctx.answerCallbackQuery();
    const action=ctx.match[1]!,id=ctx.match[2]!;
    const row=await requireVisible(id);
    await screen(ctx,`${action==='delete'?'Удалить адрес из списка?':'Отключить автозаряд?'}\n${row.tron_address}\n\n${action==='delete'?'Автозаряд будет остановлен. История останется в журнале. Для повторного обслуживания адрес можно будет добавить заново.':'Адрес останется в списке. Его можно будет снова включить.'}`,new InlineKeyboard().text('Подтвердить',`do:${action}:${id}`).text('Отмена',`a:${id}`));
  });

  bot.callbackQuery(/^do:(pause|resume|disable|delete):(\d+)$/,async (ctx)=>{
    await ctx.answerCallbackQuery();
    if (!await mutationAllowed(ctx)) return;
    flows.delete(ctx.from.id);
    const action=ctx.match[1]!,id=ctx.match[2]!;
    try {
      if (action==='delete') await service.remove(config.ALLOWED_USER_ID,id);
      else await service.changeState(config.ALLOWED_USER_ID,id,action as 'pause'|'resume'|'disable');
      if (action==='delete') await addressList(ctx);
      else await addressCard(ctx,id);
    } catch (error) {
      await ctx.reply(error instanceof Error?error.message:String(error),{reply_markup:new InlineKeyboard().text('К адресу',`a:${id}`)});
    }
    await flush();
  });

  bot.callbackQuery(/^stats:(\d+)$/,async (ctx)=>{
    await ctx.answerCallbackQuery();
    const id=ctx.match[1]!;
    const data=await getReportData(db,config.ALLOWED_USER_ID,id);
    await screen(ctx,quickReport(data),new InlineKeyboard().text('📄 Полный MD',`report:${id}`).row().text('← К адресу',`a:${id}`));
  });

  bot.callbackQuery(/^report:(\d+)$/,async (ctx)=>{
    await ctx.answerCallbackQuery({text:'Формирую отчёт…'});
    const data=await getReportData(db,config.ALLOWED_USER_ID,ctx.match[1]!);
    const buffer=Buffer.from(markdownReport(data),'utf8');
    const filename=`sohu-${data.address.tron_address}-${new Date().toISOString().slice(0,10)}.md`;
    await ctx.replyWithDocument(new InputFile(buffer,filename),{caption:`Полная статистика\n${data.address.tron_address}`});
    await logTelegramEvent(db,{userId:BigInt(ctx.from.id),direction:'out',eventType:'report.md',payload:{subscriptionId:data.address.id,filename,bytes:buffer.length}});
  });

  bot.on('message:text',async (ctx)=>{
    if (!isUser(ctx)) { await addressList(ctx); return; }
    const flow=flows.get(ctx.from.id);
    if (!flow || flow.expires<Date.now()) {
      flows.delete(ctx.from.id);
      await ctx.reply('Выберите действие в меню. Для добавления адреса нажмите «Добавить адрес».');
      return;
    }
    const text=ctx.message.text.trim();
    if (flow.step==='address') {
      if (!isValidTronAddress(text)) {
        await ctx.reply('Адрес не прошёл проверку TRON Base58Check. Проверьте его и отправьте ещё раз.');
        return;
      }
      const existing=await listSubscriptions(db,config.ALLOWED_USER_ID);
      if (existing.some(row=>row.tron_address===text)) {
        await ctx.reply('Этот адрес уже есть в списке.',{reply_markup:new InlineKeyboard().text('Все адреса','list:0')});
        return;
      }
      flows.set(ctx.from.id,{step:'initial',address:text,expires:Date.now()+30*60*1000});
      await ctx.reply(`Адрес проверен:\n${text}\n\nКакой начальный депозит (резерв) установить? Введите любую сумму в TRX, например 100 или 12,5. Допускается 0.\nРезерв — виртуальный лимит; реального залога Sohu нет.`,{reply_markup:new InlineKeyboard().text('Отмена','list:0')});
      return;
    }
    let amount: bigint;
    try { amount=parseReserveAmount(text,flow.step==='initial'); }
    catch (error) { await ctx.reply(error instanceof Error?error.message:String(error)); return; }
    flows.delete(ctx.from.id);
    const key=`telegram:${ctx.update.update_id}:reserve`;
    try {
      if (flow.step==='initial') {
        const row=await service.connect(config.ALLOWED_USER_ID,flow.address,amount,key);
        await addressCard(ctx,row.id);
      } else {
        await service.addReserve(config.ALLOWED_USER_ID,flow.id,amount,key);
        await addressCard(ctx,flow.id);
      }
    } catch (error) {
      await ctx.reply(error instanceof Error?error.message:String(error),{reply_markup:new InlineKeyboard().text('Все адреса','list:0')});
    }
    await flush();
  });

  bot.on('callback_query:data',async (ctx)=>{
    await ctx.answerCallbackQuery({text:'Кнопка устарела. Откройте обновлённое меню.'});
    await addressList(ctx);
  });

  bot.catch(async (error)=>{
    logger.error({err:error.error,updateId:error.ctx.update.update_id},'Telegram handler failed');
    try {
      await logAudit(db,{actorId:error.ctx.from?BigInt(error.ctx.from.id):undefined,eventType:'telegram.handler.failed',payload:{error:error.error instanceof Error?error.error.message:String(error.error)}});
      await error.ctx.reply('Не удалось выполнить действие. Попробуйте ещё раз через меню.',{reply_markup:new InlineKeyboard().text('Все адреса','list:0')});
    } catch (reportError) { logger.error({err:reportError},'Could not report Telegram error'); }
  });
  return {bot,notifier};
}
