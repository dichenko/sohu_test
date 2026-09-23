import { createHmac, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import type { SmartQueryData } from "./types.js";

type ApiEnvelope<T> = { code: number; msg: string; time: string; data: T };

export class SohuApiError extends Error {
  constructor(message: string, readonly status?: number, readonly response?: unknown) {
    super(message);
    this.name = "SohuApiError";
  }
}

export class SohuClient {
  constructor(private readonly config: Config, private readonly db: Db) {}

  getSmartPrice() {
    return this.request<Record<string, unknown>>("GET", "/get_smart_price");
  }

  getUserInfo() {
    return this.request<{ balance_trx: string; balance_usdt: string }>("GET", "/user_info");
  }

  delegateEnergy(input: { address: string; balanceTrx: string; depositTrx: string }) {
    return this.request<{ address: string; balance: string; status: "start" | "stop"; net_protect?: string }>(
      "POST",
      "/delegate_energy_smart",
      undefined,
      { address: input.address, balance: input.balanceTrx, channel: "high_frequency", hf_deposit: input.depositTrx, net_protect: this.config.SOHU_NET_PROTECT }
    );
  }

  queryEnergy(address: string, page = 1) {
    return this.request<SmartQueryData>("GET", "/query_energy_smart", { address, page: String(page) });
  }

  getStatistics(address: string) {
    return this.request<Record<string, unknown>>("GET", "/statistics_smart_by_address", { address });
  }

  updateEnergy(address: string, status: "start" | "stop") {
    return this.request<{ address: string; balance: string; status: "start" | "stop" }>(
      "POST", "/update_energy_smart", undefined, { address, status, net_protect: this.config.SOHU_NET_PROTECT }
    );
  }

  private async request<T>(method: "GET" | "POST", path: string, query?: Record<string, string>, form?: Record<string, string>): Promise<ApiEnvelope<T>> {
    const correlationId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", this.config.SOHU_API_SECRET)
      .update(`${this.config.SOHU_API_KEY}${timestamp}`)
      .digest("hex");
    const url = new URL(`${this.config.SOHU_BASE_URL.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const started = Date.now();
    let responseStatus: number | null = null;
    let responseBody: unknown = null;
    let errorText: string | null = null;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "x-api-key": this.config.SOHU_API_KEY,
          "x-timestamp": timestamp,
          "x-signature": signature,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {})
        },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(this.config.SOHU_REQUEST_TIMEOUT_MS)
      });
      responseStatus = response.status;
      const text = await response.text();
      try { responseBody = JSON.parse(text); } catch { responseBody = { raw_text: text }; }
      if (!response.ok) throw new SohuApiError(`Sohu HTTP ${response.status}`, response.status, responseBody);
      const envelope = responseBody as ApiEnvelope<T>;
      if (envelope.code !== 1) throw new SohuApiError(`Sohu rejected request: ${envelope.msg ?? "unknown error"}`, response.status, responseBody);
      return envelope;
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.db.query(
        `INSERT INTO provider_http_logs
          (correlation_id, method, path, request_query, request_body, response_status, response_body, duration_ms, error)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9)`,
        [correlationId, method, path, JSON.stringify(query ?? null), JSON.stringify(form ?? null), responseStatus, JSON.stringify(responseBody), Date.now() - started, errorText]
      );
    }
  }
}
