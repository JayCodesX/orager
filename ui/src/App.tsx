import React from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast.tsx";
import Configuration from "./tabs/Configuration.tsx";
import Dashboard from "./tabs/Dashboard.tsx";
import Logs from "./tabs/Logs.tsx";
import Telemetry from "./tabs/Telemetry.tsx";

const TABS = [
  { to: "/",             label: "Configuration" },
  { to: "/dashboard",   label: "Dashboard"      },
  { to: "/logs",        label: "Logs"           },
  { to: "/telemetry",   label: "Telemetry"      },
];

export default function App() {
  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-logo">or<span>ager</span></span>
          <nav className="tab-nav">
            {TABS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  "tab-link" + (isActive ? " active" : "")
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="app-content">
          <Routes>
            <Route path="/"           element={<Configuration />} />
            <Route path="/dashboard"  element={<Dashboard />} />
            <Route path="/logs"       element={<Logs />} />
            <Route path="/telemetry"  element={<Telemetry />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  );
}
