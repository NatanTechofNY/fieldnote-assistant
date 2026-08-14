import { createContext, useContext, useMemo } from "react";
import { BOOLEAN, usePreference } from "./preference";

const DOT = "\u2022";

export type DemoModeState = {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  toggle: () => void;
};

export const DemoModeContext = createContext<DemoModeState>({
  enabled: false,
  setEnabled: () => {},
  toggle: () => {},
});

export const useDemoMode = () => useContext(DemoModeContext);

/**
 * Hides the values that identify a particular installation — phone numbers,
 * provider credentials, the tunnel hostname — so the app can be screen-recorded
 * without editing the footage afterwards. It is a browser-local display setting
 * and nothing about it reaches the server, because the demo has to run against
 * real credentials to be worth recording at all.
 */
export function useDemoModeState(): DemoModeState {
  const [enabled, setEnabled] = usePreference<boolean>("demo-mode", false, BOOLEAN);
  return useMemo(
    () => ({ enabled, setEnabled, toggle: () => setEnabled(!enabled) }),
    [enabled, setEnabled],
  );
}

/**
 * Redaction replaces what is *rendered*, never what is stored. Form inputs keep
 * their real value behind a password-style field rather than being handed a
 * string of dots, so saving a card while demo mode is on cannot write the mask
 * back to the server.
 */
export function useRedact() {
  const { enabled } = useDemoMode();
  return useMemo(() => {
    const run = (length: number) => DOT.repeat(length);
    return {
      enabled,
      /** Masks a value while keeping the row it sits in the same shape. */
      text: (value: string | null | undefined, width = 10): string => {
        if (!value) return value ?? "";
        return enabled ? run(width) : value;
      },
      phone: (value: string | null | undefined): string => {
        if (!value) return value ?? "";
        return enabled ? `+${run(1)} ${run(3)} ${run(3)} ${run(4)}` : value;
      },
      email: (value: string | null | undefined): string => {
        if (!value) return value ?? "";
        return enabled ? `${run(6)}@${run(6)}` : value;
      },
      /** Keeps the scheme so a URL still reads as a URL. */
      url: (value: string | null | undefined): string => {
        if (!value) return value ?? "";
        if (!enabled) return value;
        const scheme = value.startsWith("http://") ? "http://" : "https://";
        return `${scheme}${run(14)}`;
      },
      /** `password` swaps the glyphs without touching the input's value. */
      inputType: (base: "text" | "url" | "tel" = "text"): string => (enabled ? "password" : base),
    };
  }, [enabled]);
}
