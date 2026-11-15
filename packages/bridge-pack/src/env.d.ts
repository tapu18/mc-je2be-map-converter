// Script APIの実行環境にある最小限のグローバル。DOMの型は入れない（ゲーム内にない）。
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
