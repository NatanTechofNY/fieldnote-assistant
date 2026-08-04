import { Shell } from "./components/layout/Shell";
import { ThemeContext, useThemeState } from "./lib/theme";

export default function App() {
  const theme = useThemeState();
  return <ThemeContext.Provider value={theme}><Shell /></ThemeContext.Provider>;
}
