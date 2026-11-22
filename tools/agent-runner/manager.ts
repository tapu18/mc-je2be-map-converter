import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface ManagerConfig {
  enabled: boolean;
  agent: 'codex' | 'claude';
  agentArgs: string[];
  intervalSeconds: number;
  runWhenIdle: boolean;
  minIntervalSeconds: number;
  timeoutSeconds: number;
  maxRunsPerDay: number;
  instructions: string;
}

export interface ManagerState {
  day: string;
  runs: number;
  lastStartedAt: number;
  lastFinishedAt?: number;
  error?: string;
}

export function managerConfig(input: unknown): ManagerConfig {
  const defaults: ManagerConfig = {
    enabled: false, agent: 'codex', agentArgs: [], intervalSeconds: 21600,
    runWhenIdle: true, minIntervalSeconds: 3600, timeoutSeconds: 1800, maxRunsPerDay: 4, instructions: '',
  };
  if (input === undefined) return defaults;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('manager must be an object');
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown manager key: ${key}`);
  const config = { ...defaults, ...input } as ManagerConfig;
  if (typeof config.enabled !== 'boolean' || typeof config.runWhenIdle !== 'boolean') throw new Error('Invalid manager enabled/runWhenIdle');
  if (!['codex', 'claude'].includes(config.agent) || !Array.isArray(config.agentArgs) || !config.agentArgs.every(arg => typeof arg === 'string')) throw new Error('Invalid manager agent/agentArgs');
  if (typeof config.instructions !== 'string') throw new Error('manager.instructions must be a string');
  for (const key of ['intervalSeconds', 'minIntervalSeconds', 'timeoutSeconds', 'maxRunsPerDay'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`manager.${key} must be a positive integer`);
  }
  if (config.minIntervalSeconds > config.intervalSeconds) throw new Error('manager.minIntervalSeconds must not exceed intervalSeconds');
  return config;
}

export function managerDue(config: ManagerConfig, state: ManagerState | undefined, now: number, idle: boolean): boolean {
  if (!config.enabled) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  if (state?.day === day && state.runs >= config.maxRunsPerDay) return false;
  if (!state) return true;
  const elapsed = now - Math.max(state.lastStartedAt, state.lastFinishedAt ?? 0);
  return elapsed >= config.intervalSeconds * 1000 ||
    (idle && config.runWhenIdle && elapsed >= config.minIntervalSeconds * 1000);
}

export function managerPrompt(repo: string, base: string, milestone: string | undefined, instructions: string, previousReport: string): string {
  return `あなたは ${repo} の PM 巡回です（base: ${base}）。実装担当とは別に定期的に起動されます。
対象マイルストーン: ${milestone ?? '指定なし。開いているマイルストーンと design.md 7章から、今の段階を判断してください。'}

## 役目
このプロジェクトの進め方を批判的に見直すレビュアーです。所有者に指摘される前に、計画の甘さ、作業の抜け、前提の食い違い、先で困るリスクを自分で見つけ、根拠を付けて Issue にします。
進捗を整理して報告するだけの巡回にしないでください。今の Issue を眺めて「順調」と書くのは失敗です。計画を疑い、実際の作業量や事実と照らし合わせてください。
実装はしません。人の判断が必要なものは、選択肢と推奨を添えて人に渡します。

## 最初に
- CLAUDE.md、docs/workflow.md、docs/design.md を読む。この checkout は古いことがあるので、\`git fetch origin\` の後に \`git show origin/${base}:<パス>\` で読む。ブランチは切り替えない。
- 前回の報告があれば ${previousReport} を読む。前回に扱った観点と、出した指摘の行方（Issue になったか、どう扱われたか）を確かめる。初回なら直近7日を対象にする。

## 1. 基本の整備（短く済ませる）
- 開いている Issue をページ末尾まで確認し、\`status:*\` が未設定の Issue と \`status:blocked\` の Issue を分類する。\`status:blocked\` の解除だけで済ませず、新しく作られた未分類の仕事も必ず対象にする。
- 分類前に本文・コメント・依存先の最新状態・関連 PR・有効な claim を読み直す。claim のある Issue、\`status:in-progress\`・\`status:in-review\`・\`status:paused\` の Issue には介入しない。
- 依存がすべて閉じていて、人の判断が要らず、現在の段階で着手でき、1つの PR で終わり、完了条件を機械的に確かめられる Issue を \`status:ready\` にする。状態未設定というだけでは着手可と判断しない。
- 未完了の依存、前提の未確認、完了条件や作業分割の不足がある場合は \`status:blocked\` にし、本文に阻害要因と解除条件を明記する。依存は \`Depends on: #番号\` で書く。人の判断が必要なら \`needs-approval\` も付ける。既存の \`needs-approval\` は外さず、そのまま ready にもしない。
- 未着手の Issue の状態ラベルは分類結果の1つに揃え、種類・分野など他のラベルは保持する。同じ理由を繰り返しコメントせず、根拠が変わったときだけ更新する。着手可能な Issue が0件なら、未分類・依存待ち・承認待ちなどの理由と、何が解消すれば着手できるかを報告する。
- 前回から動きのない \`status:in-progress\`・\`status:in-review\` と、CI が失敗したままの PR を見つけ、原因と解除条件を書く。

## 2. レビュー（巡回の大半の時間を使う）
次の観点から、前回扱っていないものを中心に2つ以上選び、深く調べる。全部を浅くなぞらない。
- **計画の粒度と見通し**：マイルストーンの到達点に対して、必要な作業量を実際に数えて計画と比べる。たとえば、Java のデータ生成の出力（\`servers/reports-*/reports/\` の \`commands.json\`、\`registries.json\`）にあるコマンドの形やパーティクル・エンティティなどの件数、対応表がカバーする割合、コーパスの集計。部品の単位（パーサ、ランタイム、変換器）だけで切られていて、機能ごとの互換作業が見えていないことが多い。
- **閉じた Issue の実質**：閉じた Issue が到達点のどこまでを満たしたか、残りが後続の Issue に引き継がれているか。たとえば、ID の対応表で置き換えて閉じたが、BE にない種類や Java にしかない引数の再現は残っている、など。
- **テストと検証**：design.md 6章の各層のうち、手段がないもの。正解データの範囲、確かめていない形、CI の時間の伸び、揺れるテスト、人の手の確認に頼っているところ。
- **コードの構成**：肥大化して並行作業で衝突しやすいファイル、型チェックやテストが効かないコード（文字列の中のコードなど）、パッケージの境界の崩れ、同じ仕組みの重複。この先の段階で書き足し続けて破綻しそうな構造。
- **前提の食い違い**：2つの仕組みが別々の前提に立っていないか。たとえば、地形とコマンドで別の対応表を使っている、設計書と実装が違う、閉じた Issue の結論が設計書に反映されていない。
- **製品として**：利用者（マップ作者）の環境で動くか。対応 OS、外部の依存（JRE、Python など）、導入手順、作者が読む変換レポート、持ち込まれる入力ファイルの安全。
- **権利と外部依存**：生成物に入る第三者のデータ、外部ツールのライセンスと保守の状況。
- **追従とリスク**：BE・Java・外部ツールの版の更新への備え。design.md 8章の未決事項とリスクのうち、対応する Issue がないもの。
- **進め方**：前回以降の PR と Issue での手戻り、繰り返す失敗、長い待ち、引き継ぎの不足、Issue の大きさや完了条件の甘さ。

調べ方：
- 推測で終わらせず、数える・読む・突き合わせる。コード、文書、Issue・PR・CI の履歴、\`servers/\` の生成物、コーパスの集計結果を読む。
- 読み取りだけの集計スクリプトは \`/tmp\` などリポジトリの外で書いて実行してよい。
- 数値には出所を添える。

## 3. 指摘の出し方
- 指摘1件ごとに、Issue を作るか既存の Issue にコメントする。報告に書くだけで終わらせない。
- 作る前に \`gh issue list --state all --search <語>\` で重複を確かめる。前回の報告で出した指摘を繰り返さない。
- 本文には、背景（何が問題か、根拠の数字やリンク）、作業、完了条件、境界を書く。
  - CLAUDE.md の「主張の確度」に従い、実測・推定・未確認を区別する
  - 依存は \`Depends on: #番号\` で書き、マイルストーンを付ける。どの段階にも属さないものは横断のマイルストーンに入れる
- 設計の変更・権利・公開・費用が絡むもの、マイルストーンの組み直しには \`needs-approval\` を付け、選択肢と推奨を書く。
- 新規 Issue にも、作成時に「基本の整備」と同じ判定で \`status:ready\` または \`status:blocked\` を付ける。承認が必要なら \`status:blocked\` と \`needs-approval\` を付ける。状態未設定のまま作業キューから漏らさない。
- 新しく作る Issue は1回10件まで。それを超えるほど抜けが大きいときは、全体を見渡す親の Issue を1件作り、中に一覧を書く。
- 根拠の薄い思い付きは Issue にしない。調べきれなかったものは、何を確かめれば判断できるかを報告に残し、次回に回す。

## してよいこと・しないこと
- してよい：
  - リポジトリ・GitHub・\`servers/\` の生成物の読み取りと、リポジトリの外での読み取りだけの集計
  - Issue の作成
  - 未着手の Issue の本文・ラベル・マイルストーンの整理、\`status:ready\`・\`status:blocked\` の付け外し
  - Issue へのコメント
- しない：
  - リポジトリのファイルの編集、コミット、push、PR の作成・マージ、実サーバーのテスト
  - claim のある Issue、\`status:in-progress\`・\`status:in-review\` の Issue、作業ブランチ、worktree、管理プログラムの設定・状態・ロックへの介入
  - \`needs-approval\` を外すこと、承認の代行、マイルストーンを閉じること

## 報告
最終応答は日本語の Markdown で、次の順に短く書く。報告は管理プログラムがローカルに保存する。
1. 見つけた問題と、作った Issue・コメントのリンク（1件1〜2行。根拠の要点を添える）
2. 人の判断が必要なもの（なければ「なし」）
3. 扱った観点と、調べきれず次回に回したもの（次回の巡回が続きから始められるように）
4. 基本の整備で変えたこと${instructions ? `\n\n## 追加の指示\n${instructions}` : ''}`;
}

export async function managerReport(logfile: string): Promise<string> {
  let final = '';
  const lines = createInterface({ input: createReadStream(logfile), crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') final = event.item.text;
    if (event?.type === 'result' && !event.is_error && typeof event.result === 'string') final = event.result;
  }
  if (!final.trim()) throw new Error('PM returned no final report; inspect the log');
  return final;
}
