# ptrcode

AIエージェント用ターミナルワークスペース。Tauri v2、React、xterm.js で構築。[cmux](https://github.com/manaflow-ai/cmux)にインスパイアされたプロジェクト。

## 作った経緯

cmux の UI/UX に惹かれて、macOS・Windows で動くものを自分で作ることにした。

オープンソースで公開中。今後はマルチエージェント連携ワークフローを重点的に開発予定。

高速でキーボード中心のターミナルワークスペースを、ネイティブアプリの感覚で使える。マルチペイン・マルチワークスペースの開発を、ブラウザや重い IDE に縛られずスムーズに行える。

## プロジェクトの方向性

- **短期**: 安定したリリースと簡単なインストール手段
- **品質向上**: 操作感・パフォーマンス・アクセシビリティの磨き込み
- **上位機能**: マルチエージェントスウォーム連携（ptrcode の差別化ポイント）
- **配布**: コアのリリースフローが安定した後、パッケージング手段を拡充

## 機能

- **ワークスペース**: ターミナルを別々のワークスペースに整理し、素早く切り替え
- **柔軟なペインレイアウト**: 水平・垂直に分割可能、リサイズ対応のディバイダー付き
- **位置ベースのナビゲーション**: 画面上の実際の位置に基づいて矢印キーでペイン間を移動
- **コマンドパレット**: あいまい検索で全コマンドに素早くアクセス
- **キーバインドのカスタマイズ**: 任意のショートカットを自由にリマップ
- **状態の永続化**: ワークスペースとレイアウトをセッションをまたいで保存
- **クロスプラットフォーム**: macOS、Windows 対応

## インストール

### クイックインストール（推奨）

最新リリースからアーティファクトをダウンロード:

<https://github.com/cai0baa/ptrcode/releases/latest>

#### macOS (.dmg)

```bash
gh release download --repo cai0baa/ptrcode --pattern "*.dmg"
```

`.dmg` を開いて ptrcode を Applications にドラッグ。

> **macOS セキュリティ警告**: ptrcode はまだ Apple の公証を取得していないため、初回起動時に「未確認の開発元」警告が表示される。回避方法: アプリを右クリック → **開く** → 開く。またはターミナルで: `xattr -d com.apple.quarantine /Applications/ptrcode.app`

#### Windows（.zip ポータブル版または NSIS インストーラー）

```bash
gh release download --repo cai0baa/ptrcode --pattern "*.zip"
```

展開して `ptrcode.exe` を実行。

> **Windows セキュリティ警告**: ptrcode はまだ Authenticode 証明書でコード署名されていないため、Windows SmartScreen が「Windows によって PC が保護されました」と警告する。**詳細情報** → **実行** をクリックして続行。

### ソースからビルド

#### 前提条件

- [Rust](https://rustup.rs/)（最新安定版）
- [Node.js](https://nodejs.org/)（v18以上）
- システム依存パッケージ:

  ```bash
  # macOS — Xcode Command Line Tools をインストール
  xcode-select --install

  # Windows — Visual Studio Build Tools の C++ ワークロードをインストール
  ```

```bash
git clone https://github.com/cai0baa/ptrcode.git
cd ptrcode
npm install
npm run tauri dev       # 開発モード
npm run tauri build     # 本番ビルド
```

## キーボードショートカット

ショートカットはすべて Ctrl ベースの修飾キーを使用。

### グローバル

| ショートカット | 動作 |
|----------|--------|
| `Ctrl+B` | サイドバーの表示切替 |
| `Ctrl+Shift+P` | コマンドパレットを開く |
| `Ctrl+,` | キーボードショートカット設定を開く |

### ワークスペース

| ショートカット | 動作 |
|----------|--------|
| `Ctrl+Shift+N` | 新しいワークスペース |
| `Ctrl+Tab` | 次のワークスペース |
| `Ctrl+Shift+Tab` | 前のワークスペース |
| `Ctrl+Shift+W` | ワークスペースを閉じる |
| `Ctrl+1` - `Ctrl+8` | ワークスペース 1〜8 にジャンプ |
| `Ctrl+9` | 最後のワークスペースにジャンプ |

### ペイン

| ショートカット | 動作 |
|----------|--------|
| `Ctrl+Alt+D` | ペインを右に分割 |
| `Ctrl+Alt+Shift+D` | ペインを下に分割 |
| `Ctrl+Alt+W` | アクティブなペインを閉じる |
| `Ctrl+Alt+Arrow` | 指定方向のペインにフォーカス |
| `Ctrl+Shift+Enter` | ペインのズーム切替 |
| `Ctrl+Shift+H` | フォーカス中のペインをフラッシュ |

### ターミナル

| ショートカット | 動作 |
|----------|--------|
| `Ctrl+Shift+F` | ターミナル内検索 |

## アーキテクチャ

- **フロントエンド**: React 19 + TypeScript + Vite
- **バックエンド**: Tauri v2（Rust）
- **ターミナル**: xterm.js（WebGL レンダラー）
- **状態管理**: Zustand + Immer
- **レイアウト**: Allotment（分割ペイン）

## ライセンス

GPL v3 - 詳細は [LICENSE](LICENSE) を参照。

## 謝辞

- ManaFlow の [cmux](https://github.com/manaflow-ai/cmux) にインスパイアされた
- [Tauri](https://tauri.app/)、[xterm.js](https://xtermjs.org/)、[React](https://react.dev/) で構築
