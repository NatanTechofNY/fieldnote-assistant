import { Shell } from "./components/layout/Shell";
import { DemoModeContext, useDemoModeState } from "./lib/demo-mode";
import { ThemeContext, useThemeState } from "./lib/theme";

export default function App() {
  const theme = useThemeState();
  const demoMode = useDemoModeState();
  return <ThemeContext.Provider value={theme}>
    <DemoModeContext.Provider value={demoMode}><Shell /></DemoModeContext.Provider>
  </ThemeContext.Provider>;
}
