export type SubscriptionStatus = "pending" | "active" | "paused" | "disabled" | "low_balance" | "error";

export type Subscription = {
  id: string;
  user_telegram_id: string;
  tron_address: string;
  status: SubscriptionStatus;
  souhu_status: string | null;
  souhu_credit_micros: string | null;
  deposit_micros: string;
  deposit_status: string;
  cycle_started_at: Date;
  cycle_ends_at: Date;
  cycle_energy_used: string;
  minimum_energy_72h: string;
  last_souhu_sync_at: Date | null;
  last_error: string | null;
};

export type SmartOrder = {
  energy_type?: string | null;
  amount?: number | string | null;
  balance?: number | string | null;
  currency?: string | null;
  status?: string | null;
  used_tx_id?: string | null;
  speed_mode?: string | null;
  used_energy?: number | null;
  used_times?: number | null;
  remain_times?: number | null;
  delegate_count?: number | null;
  delegate_tx_id?: string | null;
  delegate_time?: number | null;
  un_delegate_tx_id?: string | null;
  un_delegate_time?: number | null;
  createtime?: number | null;
};

export type SmartQueryData = {
  address: string;
  balance: string;
  status: "start" | "stop";
  order_count: number;
  page_size: number;
  page: number;
  orders: SmartOrder[];
};
