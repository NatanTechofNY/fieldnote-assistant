import { Shell } from "./components/layout/Shell";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { DemoModeContext, useDemoModeState } from "./lib/demo-mode";
import { ThemeContext, useThemeState } from "./lib/theme";

export default function App() {
  const theme = useThemeState();
  const demoMode = useDemoModeState();
  return <ThemeContext.Provider value={theme}>
    <DemoModeContext.Provider value={demoMode}><ConfirmProvider><Shell /></ConfirmProvider></DemoModeContext.Provider>
  </ThemeContext.Provider>;
}
