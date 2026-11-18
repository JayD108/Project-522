// Window Management API (multi-screen) types: not in TypeScript's DOM lib yet.
interface ScreenDetailed extends Screen {
  readonly availLeft: number;
  readonly availTop: number;
  readonly left: number;
  readonly top: number;
  readonly isPrimary: boolean;
  readonly isInternal: boolean;
  readonly devicePixelRatio: number;
  readonly label: string;
}

interface ScreenDetails extends EventTarget {
  readonly screens: ReadonlyArray<ScreenDetailed>;
  readonly currentScreen: ScreenDetailed;
}

interface Window {
  getScreenDetails(): Promise<ScreenDetails>;
}

interface FullscreenOptions {
  screen?: ScreenDetailed;
}
