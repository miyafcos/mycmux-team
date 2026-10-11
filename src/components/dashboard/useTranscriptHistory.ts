import { useEffect, useRef, useState } from "react";
import { readAgentSessionMappings } from "../../lib/ipc";
import type { TranscriptDescriptor } from "../../lib/livebrief";
import { descriptorKey, TranscriptHistoryReader } from "../../stores/transcriptHistoryStore";

/** The mapping is authoritative. Saved launch IDs and cwd never substitute. */
export function useArchiveDescriptor(sessionId: string | null, tabId: string | null, enabled = true): TranscriptDescriptor | null {
  const [descriptor, setDescriptor] = useState<TranscriptDescriptor | null>(null);
  useEffect(() => {
    let stopped = false; let busy = false;
    setDescriptor(null);
    if (!enabled || !sessionId || !tabId) return;
    const poll = async () => {
      if (stopped || busy || document.hidden) return;
      busy = true;
      try {
        const mappings = await readAgentSessionMappings([sessionId]);
        const mapping = mappings?.[sessionId];
        const kind = mapping?.agent_kind;
        const next = mapping?.session_id && (kind === "claude" || kind === "claude-codex" || kind === "codex") ? {ptySessionId:sessionId,tabId,expectedAgentKind:kind,expectedAgentSessionId:mapping.session_id} as TranscriptDescriptor : null;
        if (!stopped) setDescriptor((old) => old && next && descriptorKey(old)===descriptorKey(next) ? old : next);
      } catch { if (!stopped) setDescriptor(null); }
      finally { busy=false; }
    };
    void poll(); const timer=setInterval(()=>void poll(),3000);
    const visible = () => { if (!document.hidden) void poll(); }; document.addEventListener("visibilitychange",visible);
    return () => { stopped=true; clearInterval(timer); document.removeEventListener("visibilitychange",visible); };
  },[enabled,sessionId,tabId]);
  return descriptor;
}

/** Retain a mounted old source on rollover, until explicit current/reopen. */
export function useTranscriptHistory(descriptor: TranscriptDescriptor | null, prepared?: TranscriptHistoryReader): TranscriptHistoryReader | null {
  const [reader,setReader]=useState<TranscriptHistoryReader|null>(prepared??null);
  const current=useRef<TranscriptHistoryReader|null>(prepared??null);
  useEffect(()=>{
    if (prepared) { if(prepared.snapshot.status==="error" && prepared.snapshot.error==="readerBusy") prepared.reopen(); current.current=prepared; setReader(prepared); return; }
    if (!descriptor) { if(current.current) current.current.freeze(); return; }
    if (!current.current || current.current.snapshot.status==="closed") {
      current.current=new TranscriptHistoryReader(descriptor); setReader(current.current);
    } else if (descriptorKey(current.current.snapshot.descriptor)!==descriptorKey(descriptor)) current.current.freeze();
  },[descriptor,prepared]);
  useEffect(()=>()=>{ if (!prepared) { current.current?.dispose(); current.current=null; } },[prepared]);
  return reader;
}
