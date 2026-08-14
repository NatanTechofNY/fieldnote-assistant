import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, Ellipsis, LogOut, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import { api } from "../../api";
import { AskLauncher } from "../search/AskLauncher";
import { CommandPalette } from "../search/CommandPalette";
import { AgentPanelContext, useAgentPanel, useAgentPanelState } from "../../lib/agent-panel";
import { useDemoMode } from "../../lib/demo-mode";
import { useGlobalShortcuts } from "../../lib/use-global-shortcuts";
import { ReminderWatcher } from "../ReminderWatcher";
import { ThemeToggle } from "../ui";
import { AgentPanel } from "./AgentPanel";
import { ConversationHistoryPage } from "../../features/history/ConversationHistoryPage";
import { MemoriesPage } from "../../features/memories/MemoriesPage";
import { OverviewPage } from "../../features/overview/OverviewPage";
import { ReflectionsPage } from "../../features/reflections/ReflectionsPage";
import { IntegrationsPage } from "../../features/settings/IntegrationsPage";
import { SetupPage } from "../../features/setup/SetupPage";
import { TodosPage } from "../../features/todos/TodosPage";
import { nav, navApp, navMore } from "../../lib/nav";
import { useNavRail } from "../../lib/nav-rail";
import { TimezoneContext, browserTimezone } from "../../lib/timezone";

export function Shell() {
  const agentPanel = useAgentPanelState();
  return <AgentPanelContext.Provider value={agentPanel}><ShellBody /></AgentPanelContext.Provider>;
}

function ShellBody() {
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const { data: integrations } = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const timezone = integrations?.notifications.timezone || browserTimezone;
  const agentPanel = useAgentPanel();
  const rail = useNavRail();
  const demoMode = useDemoMode();
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useGlobalShortcuts({ onSearch: openSearch, onAgent: agentPanel.toggle, onDemoMode: demoMode.toggle });
  return (
    <TimezoneContext.Provider value={timezone}>
    <div className="app-shell" data-rail={rail.isCollapsed ? "collapsed" : "full"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={13} /></div>
          <h1>Fieldnote</h1>
          {/* Collapsed, the labels are gone and every row is a tooltip away, so
              the control that took them stays where the eye already is. */}
          <button
            type="button"
            className="sidebar-collapse"
            aria-label={rail.isCollapsed ? "Expand the navigation" : "Collapse the navigation"}
            aria-pressed={rail.isCollapsed}
            title={rail.isCollapsed ? "Expand the navigation" : "Collapse the navigation"}
            onClick={rail.toggle}
          >
            {rail.isCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
        <nav className="nav">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} title={label}>
              <Icon size={15} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <nav className="sidebar-more" aria-label="Secondary pages">
          {navMore.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} title={label}>
              <Icon size={13} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ThemeToggle compact />
          <SidebarMenu />
          {health?.auth?.enabled && (
            <form method="post" action="/logout">
              <button type="submit" className="signout" title="Sign out"><LogOut size={13} /><span>Sign out</span></button>
            </form>
          )}
        </div>
      </aside>
      <main className="main"><Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/memories" element={<MemoriesPage />} />
        <Route path="/reflections" element={<ReflectionsPage />} />
        <Route path="/reviews" element={<ReflectionsPage />} />
        {/* The agent used to be a page; the panel replaces it, so old links
            open the panel over the dashboard instead of 404ing. */}
        <Route path="/chat" element={<AgentRedirect />} />
        <Route path="/history" element={<ConversationHistoryPage />} />
        <Route path="/settings" element={<IntegrationsPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/setup" element={<SetupPage />} />
      </Routes></main>
      <AskLauncher onSearch={openSearch} />
      <ReminderWatcher />
      <AgentPanel />
      {searchOpen && <CommandPalette
        onClose={() => setSearchOpen(false)}
        onAskAgent={agentPanel.ask}
      />}
    </div>
    </TimezoneContext.Provider>
  );
}

/**
 * How the app works and how it is configured are things you read once and then
 * leave alone, so they live behind one quiet row at the bottom instead of two
 * more tabs in a rail that is meant to hold three.
 */
function SidebarMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [isOpen]);
  return <div className="sidebar-menu" ref={wrapper} onKeyDown={event => { if (event.key === "Escape") setIsOpen(false); }}>
    {isOpen && <div className="sidebar-menu-list" role="menu">
      {navApp.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} role="menuitem" onClick={() => setIsOpen(false)}>
          <Icon size={13} />{label}
        </NavLink>
      ))}
    </div>}
    <button
      type="button"
      className="sidebar-menu-trigger"
      title="More"
      aria-haspopup="menu"
      aria-expanded={isOpen}
      onClick={() => setIsOpen(open => !open)}
    >
      <Ellipsis size={13} /><span>More</span><ChevronUp size={12} />
    </button>
  </div>;
}

function AgentRedirect() {
  const { open } = useAgentPanel();
  // Runs on mount only, and opening the panel is the whole point of the route.
  useEffect(() => open(), [open]);
  return <Navigate to="/" replace />;
}
