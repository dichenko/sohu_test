import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import type { Db } from '../src/db.js';

export async function testDatabase(versions = ['001_initial.sql','002_provider_credit_topups.sql','003_multiple_address_reserves.sql']) {
  const engine=new PGlite();
  for (const name of versions) await engine.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const query=async (sql:string,params?:unknown[]) => {
    const result=await engine.query(sql,params);
    const rows=result.rows.map(row=>Object.fromEntries(Object.entries(row as Record<string,unknown>).map(([key,value])=>[key,typeof value==='bigint'?value.toString():value])));
    return {rows,rowCount:rows.length || result.affectedRows || 0};
  };
  const client={query,release() {}};
  const pool={query,async connect() {return client;},async end() {await engine.close();}} as unknown as Db;
  return {engine,pool};
}
