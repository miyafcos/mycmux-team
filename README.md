# cmux-linux

A Linux-native GUI terminal workspace manager inspired by [cmux](https://github.com/manaflow-ai/cmux) (macOS). Built with Tauri v2, React, and xterm.js.

## Why I built this

My first idea was to just add Linux support for CMUX directly, but after reading the PRs from their repo, I realized that if they really want to add support, they will eventually.

And that's where this project comes to life! I wanted to create something inspired by cmux for Linux. I know Linux has tmux which is actually great, however the UI/UX from cmux has me fallen in love.

This project is open source for now, but I have plans and more features for the future.

CMux Linux is built to bring a fast, keyboard-first terminal workspace experience to Linux with a native desktop app feel. The goal is to make multi-pane, multi-workspace development smooth without forcing users into a browser-only workflow or heavy IDE.

## Project direction

- **Near term**: stable Linux releases with easy install paths (AppImage + `.deb`)
- **Product quality**: stronger polish in interaction, performance, and accessibility
- **Power features**: richer automation and agent workflows over time
- **Distribution**: broader packaging options (for example Flatpak) after core release flow is stable

## Features

- **Workspaces**: Organize terminals into separate workspaces with quick switching
- **Flexible Pane Layouts**: Split panes horizontally and vertically with resizable dividers
- **Position-Based Navigation**: Navigate between panes using arrow keys based on actual screen position
- **Command Palette**: Quick access to all commands via fuzzy search
- **Customizable Keybindings**: Remap any shortcut to your preference
- **Persistent State**: Workspaces and layouts are saved across sessions

## Installation

### Quick Install (Recommended)

Download artifacts from the latest release:

<https://github.com/cai0baa/cmux-for-linux/releases/latest>

#### AppImage (works on most Linux distros)

```bash
# Download the latest *.AppImage asset from Releases
gh release download --repo cai0baa/cmux-for-linux --pattern "*.AppImage"
chmod +x ./*.AppImage
./*.AppImage
```

#### Debian/Ubuntu (.deb)

```bash
# Download the latest *.deb asset from Releases
gh release download --repo cai0baa/cmux-for-linux --pattern "*.deb"
sudo apt install ./*.deb
```

### Build from Source

#### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- System dependencies for Tauri on Linux:
  ```bash
  # Debian/Ubuntu
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev
  
  # Fedora
  sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel
  
  # Arch
  sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg
  ```

```bash
# Clone the repository
git clone https://github.com/cai0baa/cmux-for-linux.git
cd cmux-for-linux

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Keyboard Shortcuts

All shortcuts use Ctrl-based modifiers (Linux-native).

### Global

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+P` | Open command palette |
| `Ctrl+,` | Open keyboard shortcuts |

### Workspace

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+N` | New workspace |
| `Ctrl+Tab` | Next workspace |
| `Ctrl+Shift+Tab` | Previous workspace |
| `Ctrl+Shift+W` | Close workspace |
| `Ctrl+1` - `Ctrl+8` | Jump to workspace 1-8 |
| `Ctrl+9` | Jump to last workspace |

### Pane

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+D` | Split pane right |
| `Ctrl+Alt+Shift+D` | Split pane down |
| `Ctrl+Alt+W` | Close active pane |
| `Ctrl+Alt+Arrow` | Focus pane in direction |
| `Ctrl+Shift+Enter` | Toggle pane zoom |
| `Ctrl+Shift+H` | Flash focused pane |

### Terminal

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+F` | Find in terminal |

## Architecture

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Tauri v2 (Rust)
- **Terminal**: xterm.js with WebGL renderer
- **State Management**: Zustand with Immer
- **Layout**: Allotment (split panes)

## License

GPL v3 - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by [cmux](https://github.com/manaflow-ai/cmux) from ManaFlow
- Built with [Tauri](https://tauri.app/), [xterm.js](https://xtermjs.org/), and [React](https://react.dev/)
