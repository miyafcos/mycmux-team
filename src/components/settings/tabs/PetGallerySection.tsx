import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { fetchPetGallery, installPetFromGallery, quarantinePet, type GalleryPage, type GalleryPet } from "../../../lib/ipc";
import { useToastStore } from "../../../stores/toastStore";
import { dialogButtonStyle, sectionHeadingStyle } from "../tabStyles";
import { petSettingsStrings } from "../settingsStrings";

const emptyPage: GalleryPage = { pets: [], total: 0 };

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeGalleryResponse(value: unknown): GalleryPage {
  const page = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pets = Array.isArray(page.pets) ? page.pets : [];
  return {
    total: numberValue(page.total),
    pets: pets.filter((pet): pet is Record<string, unknown> => Boolean(pet) && typeof pet === "object").map((pet) => ({
      id: stringValue(pet.id), displayName: stringValue(pet.displayName), description: stringValue(pet.description),
      tags: Array.isArray(pet.tags) ? pet.tags.filter((tag): tag is string => typeof tag === "string") : [],
      likeCount: numberValue(pet.likeCount), downloadCount: numberValue(pet.downloadCount),
      previewUrl: stringValue(pet.previewUrl), posterUrl: stringValue(pet.posterUrl),
      atlasSize: stringValue(pet.atlasSize), statesDetected: numberValue(pet.statesDetected),
    })),
  };
}

export function atlasSizeBadge(atlasSize: string): string {
  if (atlasSize === "1536x1872") return "8×9";
  if (atlasSize === "1536x2080") return "8×10";
  if (atlasSize === "1536x2288") return "8×11";
  return "";
}

/**
 * previewUrl is the animation laid out side by side — 7008x104 for an eleven-row
 * pet — so a card that renders it collapses to a coloured hairline. The poster is
 * one frame at cell size, which is the shape a thumbnail wants.
 */
export function thumbnailUrl(pet: Pick<GalleryPet, "posterUrl" | "previewUrl">): string {
  return pet.posterUrl || pet.previewUrl;
}

export function isGalleryInstalled(id: string, installedIds: readonly string[]): boolean {
  return installedIds.includes(id) || installedIds.includes(`external:${id}`);
}

const PREVIEW_HEIGHT = 88;

/** Every card is the same shape, so a slow image cannot reflow the row. */
const galleryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  alignItems: "stretch",
  gap: 8,
  minWidth: 0,
};
const cardStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: `${PREVIEW_HEIGHT}px auto auto auto auto`,
  gap: 4,
  border: "1px solid var(--cmux-border)",
  borderRadius: 7,
  padding: 8,
  minWidth: 0,
  overflow: "hidden",
};
const previewSlotStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: PREVIEW_HEIGHT,
  borderRadius: 5,
  background: "var(--cmux-surface)",
  overflow: "hidden",
};
const previewImageStyle: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
};
const cardNameStyle: CSSProperties = {
  fontSize: 12,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const cardMetaStyle: CSSProperties = {
  color: "var(--cmux-text-dim)",
  fontSize: 10,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

interface PetGallerySectionProps {
  installedIds: readonly string[];
  onInstalled: () => Promise<void>;
}

export function PetGallerySection({ installedIds, onInstalled }: PetGallerySectionProps) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [gallery, setGallery] = useState<GalleryPage>(emptyPage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [quarantining, setQuarantining] = useState<string | null>(null);
  const [previewFallbacks, setPreviewFallbacks] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = globalThis.setTimeout(() => { setQuery(searchInput); setPage(1); }, 300);
    return () => globalThis.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void fetchPetGallery(query, page).then((response) => {
      if (active) setGallery(normalizeGalleryResponse(response));
    }).catch((fetchError) => {
      console.warn("[pets] Gallery fetch failed", fetchError);
      if (active) { setGallery(emptyPage); setError(String(fetchError)); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, query]);

  const pageCount = Math.max(1, Math.ceil(gallery.total / 24));
  const displayedPets = useMemo(() => gallery.pets.filter((pet) => pet.id), [gallery.pets]);

  const usePreviewFallback = (pet: GalleryPet) => {
    setPreviewFallbacks((current) => {
      if (current[pet.id] !== undefined) return current;
      return { ...current, [pet.id]: pet.previewUrl };
    });
  };

  const install = async (id: string) => {
    setInstalling(id);
    try {
      await installPetFromGallery(id);
      await onInstalled();
    } catch (installError) {
      console.warn("[pets] Gallery install failed", installError);
      useToastStore.getState().pushToast(petSettingsStrings.galleryInstallError, "error");
    } finally {
      setInstalling(null);
    }
  };

  const quarantine = async (id: string) => {
    setQuarantining(id);
    try {
      await quarantinePet(id);
      await onInstalled();
    } catch (quarantineError) {
      console.warn("[pets] Gallery quarantine failed", quarantineError);
    } finally {
      setQuarantining(null);
    }
  };

  return <section>
    <div style={sectionHeadingStyle}>{petSettingsStrings.galleryTitle}</div>
    <div style={{ margin: "-4px 0 10px", color: "var(--cmux-text-dim)", fontSize: 11, lineHeight: 1.5 }}>{petSettingsStrings.galleryHint}</div>
    <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={petSettingsStrings.gallerySearchPlaceholder} style={{ boxSizing: "border-box", width: "100%", marginBottom: 8 }} />
    {error && <div style={{ color: "var(--cmux-text)", fontSize: 11, marginBottom: 8 }}>
      {petSettingsStrings.galleryError}
      <div style={{ color: "var(--cmux-text-dim)", fontSize: 10, wordBreak: "break-all" }}>{error}</div>
    </div>}
    {!loading && !error && displayedPets.length === 0 && <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>{petSettingsStrings.galleryEmpty}</div>}
    <div style={galleryGridStyle}>
      {displayedPets.map((pet) => {
        const installed = isGalleryInstalled(pet.id, installedIds);
        const preview = previewFallbacks[pet.id] ?? thumbnailUrl(pet);
        return <article key={pet.id} style={cardStyle}>
          {/* The slot keeps its box whether or not the remote image has arrived.
              Without it, 24 images loading at their own pace leave the rows ragged. */}
          <div style={previewSlotStyle}>
            {preview
              ? <img src={preview} alt="" loading="lazy" onError={() => usePreviewFallback(pet)} style={previewImageStyle} />
              : null}
          </div>
          <div style={cardNameStyle}>{pet.displayName || pet.id}</div>
          <div style={cardMetaStyle}>{pet.tags.slice(0, 2).join(" · ")}</div>
          <div style={cardMetaStyle}>♥ {pet.likeCount}{atlasSizeBadge(pet.atlasSize) ? ` · ${atlasSizeBadge(pet.atlasSize)}` : ""}</div>
          <button type="button" style={{ ...dialogButtonStyle, width: "100%" }} disabled={installing === pet.id || quarantining === pet.id} onClick={() => void (installed ? quarantine(pet.id) : install(pet.id))}>
            {installed ? petSettingsStrings.galleryQuarantine : installing === pet.id ? petSettingsStrings.galleryInstalling : petSettingsStrings.galleryInstall}
          </button>
        </article>;
      })}
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 8 }}>
      <button type="button" style={dialogButtonStyle} disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>{petSettingsStrings.galleryPrev}</button>
      <span style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>{petSettingsStrings.galleryCount(gallery.total)}</span>
      <button type="button" style={dialogButtonStyle} disabled={page >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>{petSettingsStrings.galleryNext}</button>
    </div>
  </section>;
}
