/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' builds the desktop app without update checks (see CONTRIBUTING.md) */
  readonly VITE_NO_UPDATE_CHECK?: string
}
