import { useCallback, useEffect, useState } from "react";
import { Package, Download, Trash2, Eye } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import api, { type DeliverableInfo } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";

/**
 * The deliverables inbox — finished artifacts a bot moved via bot_deliver
 * into its owner-curated outputs zone. Exempt from the retention janitor:
 * nothing here disappears automatically; removal is an explicit owner action.
 */
export function DeliverablesList({
  botId,
  botNames,
  lastDelivery,
  compact = false,
}: {
  /** undefined = fleet-wide inbox (all bots). */
  botId?: string;
  botNames?: Record<string, string>;
  lastDelivery?: { botId: string; name: string; at: number } | null;
  compact?: boolean;
}) {
  const [outputs, setOutputs] = useState<DeliverableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ d: DeliverableInfo; content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = botId ? await api.bots.botOutputs(botId) : await api.bots.outputs();
      setOutputs(data.outputs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    void refresh();
  }, [refresh, lastDelivery?.name, lastDelivery?.at]);

  const openPreview = async (d: DeliverableInfo) => {
    try {
      const { preview, truncated } = await api.bots.outputPreview(d.botId, d.name);
      setPreview({ d, content: preview, truncated });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (d: DeliverableInfo) => {
    try {
      await api.bots.deleteOutput(d.botId, d.name);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Package className="h-4 w-4" />
          {botId ? "Delivered artifacts" : "Deliverables across the whole fleet"}
          <span className="text-xs">— protected from auto-cleanup; removed only by you</span>
        </p>
        {error && <Badge variant="destructive" className="text-xs">{error}</Badge>}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : outputs.length === 0 ? (
        <Card>
          <CardContent className={cn("py-6 text-center text-sm text-muted-foreground")}>
            No deliverables yet. Bots deliver finished artifacts with their <code>bot_deliver</code> tool
            (a report, export, dataset — anything final). They appear here the moment they land.
          </CardContent>
        </Card>
      ) : (
        <Card className={compact ? "max-h-72" : ""}>
          <CardContent className="pt-4 space-y-1.5">
            {outputs.map((d) => (
              <div key={`${d.botId}/${d.name}`} className="flex items-center gap-2 text-sm group">
                {!botId && (
                  <Badge variant="secondary" className="shrink-0 max-w-40 truncate">
                    {botNames?.[d.botId] ?? d.botId}
                  </Badge>
                )}
                <span className="truncate flex-1" title={d.name}>{d.name}</span>
                <span className="text-muted-foreground text-xs shrink-0">
                  {formatBytes(d.bytes)} · {formatDate(d.mtimeMs)}
                </span>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="icon" variant="ghost" className="h-7 w-7" title="Preview" onClick={() => void openPreview(d)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" title="Download" asChild>
                    <a href={api.bots.outputDownloadUrl(d.botId, d.name)} download>
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Remove" onClick={() => void remove(d)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {preview && (
        <Dialog open onOpenChange={(o) => { if (!o) setPreview(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle className="truncate flex items-center gap-2">
                <Package className="h-4 w-4" /> {preview.d.name}
              </DialogTitle>
              <DialogDescription>
                {botNames?.[preview.d.botId] ?? preview.d.botId} · {formatBytes(preview.d.bytes)}
                {preview.truncated ? " · showing the first 64KB" : ""}
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted/50 p-4 text-xs whitespace-pre-wrap">
              {preview.content}
            </pre>
            <div className="flex justify-end gap-2">
              <Button size="sm" asChild>
                <a href={api.bots.outputDownloadUrl(preview.d.botId, preview.d.name)} download>
                  <Download className="h-4 w-4" /> Download
                </a>
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}