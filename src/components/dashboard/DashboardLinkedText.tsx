import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { open } from "@tauri-apps/plugin-shell";

import { openPathWithDefaultApp, previewArtifactUriForSessionV2, revealPathInExplorer, type PreviewArtifactInfo } from "../../lib/ipc";
import { useWorkspaceLayoutStore } from "../../stores/workspaceStore";
import {
  HTTP_LINK_REGEX,
  isArtifactPreviewUri,
  isDirectoryLikeUri,
  resolveTextLocalPathLinks,
  type ResolvedLocalPathLinkMatch,
} from "../terminal/terminalLinkProvider";
import { dashboardStrings } from "./dashboardStrings";

export type DashboardLinkContext = {
  workspaceId: string;
  paneId: string;
  sessionId: string;
  canPreviewInternally: boolean;
  openInDashboardPreview?: (info: PreviewArtifactInfo) => void;
};

type TextLinkMatch = {
  kind: "path" | "url";
  text: string;
  index: number;
  endIndex: number;
  uri: string;
};

function hasTextSelection(): boolean {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function findHttpLinks(text: string): TextLinkMatch[] {
  const regex = new RegExp(HTTP_LINK_REGEX.source, "gi");
  const matches: TextLinkMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    matches.push({
      kind: "url",
      text: match[0],
      index: match.index,
      endIndex: match.index + match[0].length,
      uri: match[0],
    });
  }
  return matches;
}

function combineMatches(
  paths: readonly ResolvedLocalPathLinkMatch[],
  text: string,
  linksEnabled: boolean,
): TextLinkMatch[] {
  if (!linksEnabled) return [];
  const pathMatches = paths.map((match) => ({
    kind: "path" as const,
    text: match.text,
    index: match.index,
    endIndex: match.endIndex,
    uri: match.activationUri,
  }));
  return [...pathMatches, ...findHttpLinks(text)]
    .sort((left, right) => left.index - right.index || right.endIndex - left.endIndex)
    .reduce<TextLinkMatch[]>((selected, match) => {
      const previous = selected[selected.length - 1];
      if (!previous || previous.endIndex <= match.index) selected.push(match);
      return selected;
    }, []);
}

function LinkButton({
  children,
  onActivate,
}: {
  children: ReactNode;
  onActivate: () => void;
}) {
  const activate = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (hasTextSelection()) return;
    onActivate();
  }, [onActivate]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate();
  }, [onActivate]);
  return <a href="#" className="cmux-dashboard-content-link" onClick={activate} onKeyDown={onKeyDown}>{children}</a>;
}

export function DashboardLinkedText({
  text,
  context = null,
  linksEnabled = true,
}: {
  text: string;
  context?: DashboardLinkContext | null;
  linksEnabled?: boolean;
}) {
  const [paths, setPaths] = useState<readonly ResolvedLocalPathLinkMatch[]>([]);
  const [fileActionUri, setFileActionUri] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const openOrReloadHtmlPreviewPane = useWorkspaceLayoutStore((state) => state.openOrReloadHtmlPreviewPane);

  useEffect(() => {
    setActionError(null);
  }, [fileActionUri]);

  useEffect(() => {
    if (!linksEnabled) {
      setPaths([]);
      return;
    }
    let active = true;
    void resolveTextLocalPathLinks(text).then((resolved) => {
      if (active) setPaths(resolved);
    }).catch(() => {
      if (active) setPaths([]);
    });
    return () => { active = false; };
  }, [linksEnabled, text]);

  const openOrPreview = useCallback((uri: string) => {
    if (!context?.canPreviewInternally) {
      void open(uri);
      return;
    }
    const openInDashboard = context.openInDashboardPreview && isArtifactPreviewUri(uri)
      ? context.openInDashboardPreview
      : null;
    void previewArtifactUriForSessionV2(context.sessionId, uri)
      .then((info) => {
        if (openInDashboard) openInDashboard(info);
        else openOrReloadHtmlPreviewPane(context.workspaceId, context.paneId, info);
      })
      .catch(() => { void open(uri); });
  }, [context, openOrReloadHtmlPreviewPane]);

  const activatePath = useCallback((uri: string) => {
    if (isArtifactPreviewUri(uri)) {
      openOrPreview(uri);
      return;
    }
    if (isDirectoryLikeUri(uri)) {
      void revealPathInExplorer(uri);
      return;
    }
    setFileActionUri(uri);
  }, [openOrPreview]);

  const matches = useMemo(() => combineMatches(paths, text, linksEnabled), [linksEnabled, paths, text]);
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (cursor < match.index) content.push(<Fragment key={`text-${cursor}`}>{text.slice(cursor, match.index)}</Fragment>);
    content.push(
      <LinkButton
        key={`link-${match.index}-${match.endIndex}`}
        onActivate={() => match.kind === "url" ? openOrPreview(match.uri) : activatePath(match.uri)}
      >
        {match.text}
      </LinkButton>,
    );
    cursor = match.endIndex;
  }
  if (cursor < text.length) content.push(<Fragment key={`text-${cursor}`}>{text.slice(cursor)}</Fragment>);

  return <>
    {content}
    {fileActionUri ? <span className="cmux-dashboard-path-actions" data-livebrief-interactive="true">
      <button type="button" onClick={() => {
        setActionError(null);
        void openPathWithDefaultApp(fileActionUri)
          .then(() => setFileActionUri(null))
          .catch((error) => setActionError(dashboardStrings.pathActionFailed(String(error))));
      }}>{dashboardStrings.pathActionOpenDefault}</button>
      <button type="button" onClick={() => {
        setActionError(null);
        void revealPathInExplorer(fileActionUri)
          .then(() => setFileActionUri(null))
          .catch((error) => setActionError(dashboardStrings.pathActionFailed(String(error))));
      }}>{dashboardStrings.pathActionReveal}</button>
      {actionError ? <span className="cmux-dashboard-path-action-error" role="alert" style={{ color: "var(--status-error)" }}>{actionError}</span> : null}
    </span> : null}
  </>;
}

export function DashboardUrlLink({
  url,
  children,
  context = null,
}: {
  url: string;
  children: ReactNode;
  context?: DashboardLinkContext | null;
}) {
  const openOrReloadHtmlPreviewPane = useWorkspaceLayoutStore((state) => state.openOrReloadHtmlPreviewPane);
  const activate = useCallback(() => {
    if (!context?.canPreviewInternally) {
      void open(url);
      return;
    }
    const openInDashboard = context.openInDashboardPreview && isArtifactPreviewUri(url)
      ? context.openInDashboardPreview
      : null;
    void previewArtifactUriForSessionV2(context.sessionId, url)
      .then((info) => {
        if (openInDashboard) openInDashboard(info);
        else openOrReloadHtmlPreviewPane(context.workspaceId, context.paneId, info);
      })
      .catch(() => { void open(url); });
  }, [context, openOrReloadHtmlPreviewPane, url]);
  return <LinkButton onActivate={activate}>{children}</LinkButton>;
}
