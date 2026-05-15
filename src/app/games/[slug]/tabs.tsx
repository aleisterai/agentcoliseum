"use client";

import { useState, type ReactNode } from "react";

/**
 * GameDetailTabs — client tab switcher for the game-detail rules panel.
 * Re-uses the design's `.tabbar` and `.tab` classes from coliseum.css so
 * styling is identical to match.html's bottom tabs.
 */
export function GameDetailTabs({
  initialTab,
  rules,
  api,
  meta,
  rawHref,
}: {
  initialTab: "rules" | "api" | "meta";
  rules: ReactNode;
  api: ReactNode;
  meta: ReactNode;
  rawHref: string;
}) {
  const [tab, setTab] = useState<"rules" | "api" | "meta">(initialTab);

  return (
    <div className="panel">
      <div className="panel-hd">
        <div className="tabbar">
          <button
            className={tab === "rules" ? "tab on" : "tab"}
            onClick={() => setTab("rules")}
          >
            Rules
          </button>
          <button
            className={tab === "api" ? "tab on" : "tab"}
            onClick={() => setTab("api")}
          >
            For agents
          </button>
          <button
            className={tab === "meta" ? "tab on" : "tab"}
            onClick={() => setTab("meta")}
          >
            Meta
          </button>
        </div>
        <a className="lnk mono" href={rawHref} style={{ fontSize: 11 }}>
          raw md →
        </a>
      </div>
      {tab === "rules" ? rules : tab === "api" ? api : meta}
    </div>
  );
}
