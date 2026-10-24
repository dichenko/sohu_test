import type { Db } from './db.js';
import { transaction } from './db.js';
import { microsToTrx } from './money.js';
import { getLedger, getSubscription, getUsage } from './repository.js';
import type { LedgerEntry, Subscription, UsageEvent } from './types.js';

export const statusLabels: Record<string,string> = {
  pending:'подключение',active:'активен',paused:'на паузе',disabled:'отключён',low_balance:'нужно пополнение',error:'требуется сверка'
};
export function reportDate(value: Date | null): string {
  return value ? new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}) : '—';
}

export type ReportData = {address: Subscription; usage: UsageEvent[]; ledger: LedgerEntry[]};
export async function getReportData(db: Db, userId: bigint, id: string): Promise<ReportData> {
  return transaction(db,async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const address=await getSubscription(client,userId,id);
    if (!address) throw new Error('Адрес удалён или не найден');
    return {address,usage:await getUsage(client,id),ledger:await getLedger(client,id)};
  });
}

export function reportTotals(data: ReportData) {
  const sum=(key:'charged_micros'|'refunded_micros'|'fee_micros'|'used_energy'|'allocated_energy')=>
    data.usage.reduce((total,row)=>total+BigInt(row[key]??0),0n);
  const toppedUp=data.ledger.filter(row=>row.kind==='reserve_topup').reduce((total,row)=>total+BigInt(row.amount_micros),0n);
  const charged=sum('charged_micros'),refunded=sum('refunded_micros');
  return {count:data.usage.length,charged,refunded,fees:sum('fee_micros'),used:sum('used_energy'),allocated:sum('allocated_energy'),net:charged-refunded,toppedUp};
}

export function quickReport(data: ReportData): string {
  const totals=reportTotals(data);
  const lines=[
    '📊 Статистика адреса',data.address.tron_address,
    `Резерв: ${microsToTrx(BigInt(data.address.reserve_balance_micros))} TRX`,
    `За всё время: ${totals.count} операций; ${totals.used} энергии.`,
    `Списано: ${microsToTrx(totals.charged)}; возвращено: ${microsToTrx(totals.refunded)} TRX.`,
    `Итоговый расход: ${microsToTrx(totals.net)} TRX, в том числе комиссии ${microsToTrx(totals.fees)} TRX.`,
    '', 'Последние 10 операций (МСК):'
  ];
  if (!data.usage.length) lines.push('Операций пока нет.');
  for (const row of data.usage.slice(0,10)) {
    lines.push(`${reportDate(row.source_created_at??row.processed_at)} · ${row.allocated_energy} / ${row.used_energy} энергии`,
      `−${microsToTrx(BigInt(row.charged_micros))} (ком. ${microsToTrx(BigInt(row.fee_micros))}) / возврат +${microsToTrx(BigInt(row.refunded_micros))}; остаток ${row.balance_after_micros==null?'—':microsToTrx(BigInt(row.balance_after_micros))} TRX`);
  }
  return lines.join('\n');
}

const cell=(value: unknown)=>String(value??'—').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
export function markdownReport(data: ReportData, generatedAt = new Date()): string {
  const totals=reportTotals(data);
  const lines=[
    '# Отчёт Автозаряд Pro',
    '',`Адрес: \`${data.address.tron_address}\``,
    `Сформирован: ${reportDate(generatedAt)} (МСК)`,
    `Добавлен: ${reportDate(data.address.created_at)} (МСК)`,
    `Состояние: ${statusLabels[data.address.status]??data.address.status}`,
    `Текущий виртуальный резерв: ${microsToTrx(BigInt(data.address.reserve_balance_micros))} TRX`,
    '', '## Итоги', '',
    `- Пополнения виртуального резерва: ${microsToTrx(totals.toppedUp)} TRX`,
    `- Операций: ${totals.count}`,
    `- Выделено энергии: ${totals.allocated}`,
    `- Использовано энергии: ${totals.used}`,
    `- Списано с комиссиями: ${microsToTrx(totals.charged)} TRX`,
    `- Комиссии (включены в списания): ${microsToTrx(totals.fees)} TRX`,
    `- Возвращено: ${microsToTrx(totals.refunded)} TRX`,
    `- Чистый расход: ${microsToTrx(totals.net)} TRX`,
    '', '## Полная история энергии', '',
    '| Дата МСК | Выделено | Использовано | Стоимость Sohu TRX | Списано TRX | Комиссия TRX | Возврат TRX | Итого TRX | Остаток TRX | Транзакция |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const row of [...data.usage].reverse()) {
    lines.push('| '+[
      reportDate(row.source_created_at??row.processed_at),row.allocated_energy,row.used_energy,
      row.souhu_cost_micros==null?'—':microsToTrx(BigInt(row.souhu_cost_micros)),
      microsToTrx(BigInt(row.charged_micros)),microsToTrx(BigInt(row.fee_micros)),microsToTrx(BigInt(row.refunded_micros)),
      microsToTrx(BigInt(row.charged_micros)-BigInt(row.refunded_micros)),
      row.balance_after_micros==null?'—':microsToTrx(BigInt(row.balance_after_micros)),
      `[${row.used_tx_id}](https://tronscan.org/#/transaction/${row.used_tx_id})`
    ].map(cell).join(' | ')+' |');
  }
  lines.push('', '## Все движения виртуального резерва', '',
    '| Дата МСК | Операция | Сумма TRX | Остаток TRX | Описание |',
    '| --- | --- | ---: | ---: | --- |');
  for (const row of data.ledger) {
    lines.push('| '+[reportDate(row.created_at),row.kind,microsToTrx(BigInt(row.amount_micros)),microsToTrx(BigInt(row.balance_after_micros)),row.description].map(cell).join(' | ')+' |');
  }
  lines.push('', 'Резерв — виртуальный лимит, задаваемый владельцем. Пополнения резерва не являются платежами в Sohu.', '');
  return lines.join('\n');
}
