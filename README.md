# mycmux-lite

チーム配布用のターミナルワークスペース。Tauri v2 + React + xterm.js 製。

[mycmux](https://github.com/miyafcos/mycmux)（個人版）からファイルエクスプローラーサイドバーと AI バディ機能を取り除いた、チーム配布向けの軽量版。

## 機能

- **ワークスペース**: ターミナルを別々のワークスペースに整理し、素早く切り替え
- **柔軟なペインレイアウト**: 水平・垂直に分割可能、リサイズ対応のディバイダー付き
- **位置ベースのナビゲーション**: 画面上の実際の位置に基づいて矢印キーでペイン間を移動
- **コマンドパレット**: あいまい検索で全コマンドに素早くアクセス
- **キーバインドのカスタマイズ**: 任意のショートカットを自由にリマップ
- **状態の永続化**: ワークスペースとレイアウトをセッションをまたいで保存
- **リモートターミナル**: WebSocket / QR コード経由で iPhone からアクセス可能（Tailscale 対応）
- **クロスプラットフォーム**: macOS、Windows 対応

## このフォークで削除した機能

- 右サイドバー（ファイルエクスプローラー、Ctrl+P パスジャンパー、ファイル検索）
- AI コンパニオンウィジェット（Claude Buddy）

動作が不安定だったため、チーム配布前に取り外してある。必要になったら個人版 [mycmux](https://github.com/miyafcos/mycmux) を参照。

## インストール

### リリースから

```bash
gh release download --repo miyafcos/mycmux-team --pattern "*.zip"   # Windows
gh release download --repo miyafcos/mycmux-team --pattern "*.dmg"   # macOS
```

Windows: `.zip` を展開して `mycmux-lite.exe` を実行。
macOS: `.dmg` を開いて Applications にドラッグ。

> **Windows**: Authenticode 署名なし。SmartScreen が警告したら「詳細情報 → 実行」で続行。
> **macOS**: Apple 公証なし。初回起動は右クリック → 開く → 開く、または `xattr -d com.apple.quarantine /Applications/mycmux-lite.app`。

### ソースからビルド

必要環境:
- [Rust](https://rustup.rs/)（最新安定版）
- [Node.js](https://nodejs.org/)（v18 以上）
- Windows は Visual Studio Build Tools の C++ ワークロード、macOS は Xcode Command Line Tools

```bash
git clone https://github.com/miyafcos/mycmux-team.git
cd mycmux-team
npm install
npm run tauri dev       # 開発モード
npm run tauri build     # 本番ビルド
```

## キーボードショートカット

修飾キーはすべて Ctrl ベース。設定画面から自由にリマップ可。

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

GPL-3.0 - 詳細は [LICENSE](LICENSE) を参照。

## 上流とクレジット

このプロジェクトは以下のオープンソースプロジェクトの派生です。

- [cai0baa/cmux-for-linux](https://github.com/cai0baa/cmux-for-linux) - 直接のフォーク元（GPL-3.0）
- [ManaFlow の cmux](https://github.com/manaflow-ai/cmux) - オリジナルの cmux

GPL-3.0 の条件に従って、ソースコードと変更点を公開しています。

- [Tauri](https://tauri.app/)
- [xterm.js](https://xtermjs.org/)
- [React](https://react.dev/)
