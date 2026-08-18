// 実行時モジュール automation-driver-kit を CJS のまま保つため、型だけをこのモジュールに分離している。

export type JsonObject = Record<string, any>;

export type DriverResult = {
  action: "skip" | "done" | "needs_llm" | "error";
  summary: string;
  [key: string]: any;
};

export type CommandRunner = {
  runText(args: string[], options?: { input?: string; check?: boolean }): string;
  runJson(args: string[], options?: { input?: string }): any;
};
