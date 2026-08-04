import { Award, BookOpen, Brain, LayoutDashboard, ListTodo, Network, Settings2 } from "lucide-react";

// The agent is not here on purpose: it is a side panel reachable from anywhere
// with Cmd/Ctrl+I rather than a page you navigate to.
export const nav = [
  { to: "/", label: "Today", icon: LayoutDashboard },
  { to: "/todos", label: "Board", icon: ListTodo },
  { to: "/memories", label: "Memory", icon: Brain },
];

/**
 * Your own material, one step back: worth a click, not worth the same weight as
 * the three surfaces used every day.
 */
export const navMore = [
  { to: "/reflections", label: "Reflections", icon: Award },
  { to: "/history", label: "History", icon: BookOpen },
];

/** The app talking about itself, which belongs in a menu at the bottom. */
export const navApp = [
  { to: "/setup", label: "How it works", icon: Network },
  { to: "/settings", label: "Settings", icon: Settings2 },
];
