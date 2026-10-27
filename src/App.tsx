import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BookOpen,
  Plus,
  Play,
  ArrowLeft,
  Crosshair,
  Trash2,
  Download,
  PanelRightClose,
  PanelRightOpen,
  Eye,
  EyeOff,
  Upload,
} from 'lucide-react';
import { ClinicalCaseItem } from './types';
import {
  fetchPublicCatalog,
  listClinicalCasesFromIndexedDB,
  saveClinicalCaseToIndexedDB,
  deleteClinicalCaseFromIndexedDB,
  inspectTPackFile,
} from './db/casesDb';

const PROD_VIEWER_EMBED_URL = 'https://mrthomaslef.github.io/dicomviewer/?embed=1';

export const App: React.FC = () => {
  const [localCases, setLocalCases] = useState<ClinicalCaseItem[]>([]);
  const [publicCases, setPublicCases] = useState<ClinicalCaseItem[]>([]);
  const [activeCase, setActiveCase] = useState<ClinicalCaseItem | null>(null);
  const [filterModality, setFilterModality] = useState<string>('ALL');

  // Volet droit pliable (foldable)
  const [isSidePanelOpen, setIsSidePanelOpen] = useState<boolean>(true);
  // Affichage / masquage du diagnostic pour l'auto-évaluation
  const [showDiagnosis, setShowDiagnosis] = useState<boolean>(false);

  const viewerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshCases = useCallback(async () => {
    const [loc, pub] = await Promise.all([
      listClinicalCasesFromIndexedDB(),
      fetchPublicCatalog(),
    ]);
    setLocalCases(loc);
    setPublicCases(pub);
  }, []);

  useEffect(() => {
    refreshCases();
  }, [refreshCases]);

  const allCases = useMemo(() => {
    return [
      ...localCases,
      ...publicCases.filter((p) => !localCases.some((l) => l.id === p.id)),
    ];
  }, [localCases, publicCases]);

  const filteredCases = useMemo(() => {
    if (filterModality === 'ALL') return allCases;
    return allCases.filter((c) => c.modality === filterModality);
  }, [allCases, filterModality]);

  // Envoie le buffer .tpack directement au lecteur embarqué
  const pushCaseToEmbeddedViewer = useCallback((caseItem: ClinicalCaseItem) => {
    const win = viewerIframeRef.current?.contentWindow;
    if (!win) return;

    if (caseItem.tpackBytes) {
      win.postMessage(
        {
          type: 'TPACK_LOAD_BUFFER',
          buffer: caseItem.tpackBytes,
        },
        '*'
      );
    } else if (caseItem.tpackUrl) {
      win.postMessage(
        {
          type: 'TPACK_LOAD_URL',
          url: new URL(caseItem.tpackUrl, window.location.href).href,
        },
        '*'
      );
    }
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'TPACK_EMBED_READY' && activeCase) {
        pushCaseToEmbeddedViewer(activeCase);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeCase, pushCaseToEmbeddedViewer]);

  // Dès que activeCase change et que l'iframe est déjà chargée, pousse le nouveau buffer .tpack
  useEffect(() => {
    if (activeCase) {
      pushCaseToEmbeddedViewer(activeCase);
    }
  }, [activeCase, pushCaseToEmbeddedViewer]);

  const sendGotoCommand = (opts: {
    sliceIndex?: number;
    windowKey?: string;
    seriesId?: string;
    showAnnotations?: boolean;
  }) => {
    const win = viewerIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'TPACK_GOTO', ...opts }, '*');
  };

  const handleOpenCaseStudy = (c: ClinicalCaseItem) => {
    setActiveCase(c);
    setShowDiagnosis(false);
    setIsSidePanelOpen(window.innerWidth >= 768);
  };

  /**
   * Import direct en 1 clic : extrait toutes les métadonnées (titre, clinique, diagnostic,
   * coupe clé et annotations) directement depuis le manifest.json interne du fichier .tpack !
   */
  const handleImportTPackFiles = async (files: FileList | File[]) => {
    let lastImported: ClinicalCaseItem | null = null;

    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.tpack') && !file.name.toLowerCase().endsWith('.zip')) {
        continue;
      }
      try {
        const { manifest, bytes } = await inspectTPackFile(file);
        const firstSeries = manifest.series?.[0];

        // Recense automatiquement toutes les coupes porteuses d'annotations dans le .tpack
        const annotatedSlices: { seriesId: string; sliceIndex: number; label: string }[] = [];
        for (const s of manifest.series || []) {
          for (const sl of s.slices || []) {
            if (sl.annotations && sl.annotations.length > 0) {
              const firstLabel =
                sl.annotations.find((a) => a.label)?.label || `Coupe #${sl.index + 1}`;
              annotatedSlices.push({
                seriesId: s.id,
                sliceIndex: sl.index,
                label: firstLabel,
              });
            }
          }
        }

        const keySliceIndex =
          typeof manifest.keySliceIndex === 'number'
            ? manifest.keySliceIndex
            : annotatedSlices.length > 0
            ? annotatedSlices[0].sliceIndex
            : Math.floor((firstSeries?.sliceCount || 1) / 2);

        const keyWindowKey =
          manifest.keyWindowKey || firstSeries?.availableWindows?.[0]?.key || 'default';

        const item: ClinicalCaseItem = {
          id: manifest.caseId || `CAS-${Date.now()}`,
          title: manifest.title || file.name.replace(/\.tpack$/i, ''),
          modality: manifest.modality || 'CT',
          anatomicalRegion: manifest.anatomicalRegion || '',
          clinicalHistory: manifest.clinicalHistory || '',
          diagnosis: manifest.diagnosis || '',
          keySliceIndex,
          keyWindowKey,
          keySeriesId: firstSeries?.id,
          annotatedSlices,
          createdAt: new Date().toISOString(),
          byteSize: bytes.byteLength,
          source: 'indexeddb',
          tpackBytes: bytes,
          manifest,
        };

        await saveClinicalCaseToIndexedDB(item);
        lastImported = item;
      } catch {
        // Ignorer si le fichier n'est pas un .tpack valide
      }
    }

    await refreshCases();
    if (lastImported) {
      handleOpenCaseStudy(lastImported);
    }
  };

  const handleDownloadCaseTpack = (c: ClinicalCaseItem) => {
    if (!c.tpackBytes) return;
    const blob = new Blob(
      [
        c.tpackBytes.buffer.slice(
          c.tpackBytes.byteOffset,
          c.tpackBytes.byteOffset + c.tpackBytes.byteLength
        ) as ArrayBuffer,
      ],
      { type: 'application/octet-stream' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.id.toLowerCase()}.tpack`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="h-[100dvh] w-screen flex flex-col bg-[#090D16] text-slate-100 overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) {
          handleImportTPackFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Input caché d'import direct en 1 clic (sans formulaire post-import) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".tpack,.zip"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            handleImportTPackFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* HEADER COMPACT */}
      <header className="h-11 shrink-0 bg-[#090D16] border-b border-slate-800/90 px-3 flex items-center justify-between gap-2 z-30">
        <div className="flex items-center gap-2 min-w-0">
          {activeCase ? (
            <button
              type="button"
              onClick={() => setActiveCase(null)}
              className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-cyan-300 flex items-center gap-1 transition cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Catalogue</span>
            </button>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <BookOpen className="w-3.5 h-3.5" />
            </div>
          )}

          <span className="font-bold text-xs sm:text-sm text-white truncate">
            {activeCase ? activeCase.title : 'TPack.cases'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center gap-1 transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Importer .tpack</span>
          </button>

          {activeCase && (
            <button
              type="button"
              onClick={() => setIsSidePanelOpen((v) => !v)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 border transition cursor-pointer ${
                isSidePanelOpen
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-cyan-500/50'
              }`}
              title="Replier / Déplier le volet clinique"
            >
              {isSidePanelOpen ? (
                <PanelRightClose className="w-3.5 h-3.5 text-cyan-400" />
              ) : (
                <PanelRightOpen className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <span className="hidden sm:inline">Infos</span>
            </button>
          )}
        </div>
      </header>

      {/* VUE 1 : LECTEUR .TPACK PLEIN ÉCRAN + VOLET DROIT PLIABLE */}
      {activeCase ? (
        <div className="flex-1 min-h-0 w-full flex relative overflow-hidden">
          <div className="relative flex-1 min-w-0 min-h-0 h-full bg-[#090D16]">
            <iframe
              ref={viewerIframeRef}
              src={PROD_VIEWER_EMBED_URL}
              title={activeCase.title}
              className="absolute inset-0 w-full h-full border-0 block bg-[#090D16]"
              allow="fullscreen"
              onLoad={() => pushCaseToEmbeddedViewer(activeCase)}
            />
          </div>

          {/* VOLET DROIT PLIABLE (lit directement les métadonnées du .tpack) */}
          {isSidePanelOpen && (
            <aside className="w-64 sm:w-72 h-full bg-[#0B101B]/95 backdrop-blur-md border-l border-slate-800 p-3.5 overflow-y-auto flex flex-col gap-3 z-30 absolute right-0 top-0 bottom-0 md:static shrink-0 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                    {activeCase.modality}
                  </span>
                  {activeCase.anatomicalRegion && (
                    <span className="text-xs font-medium text-slate-300 truncate">
                      {activeCase.anatomicalRegion}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setIsSidePanelOpen(false)}
                  className="p-1 rounded text-slate-400 hover:text-white cursor-pointer"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>

              {/* Information clinique issue du .tpack */}
              {activeCase.clinicalHistory && (
                <div className="space-y-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Clinique
                  </div>
                  <p className="text-xs text-slate-200 leading-snug bg-slate-900/70 p-2.5 rounded-lg border border-slate-800/80">
                    {activeCase.clinicalHistory}
                  </p>
                </div>
              )}

              {/* Accès direct à la coupe clé et aux annotations du .tpack */}
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() =>
                    sendGotoCommand({
                      seriesId: activeCase.keySeriesId,
                      sliceIndex: activeCase.keySliceIndex,
                      windowKey: activeCase.keyWindowKey,
                      showAnnotations: true,
                    })
                  }
                  className="w-full py-1.5 px-2.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Coupe Clé (#{activeCase.keySliceIndex + 1})</span>
                </button>

                {activeCase.annotatedSlices && activeCase.annotatedSlices.length > 0 && (
                  <div className="space-y-1 pt-1">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Annotations ({activeCase.annotatedSlices.length})
                    </div>
                    {activeCase.annotatedSlices.map((ann, i) => (
                      <button
                        key={`${ann.seriesId}_${ann.sliceIndex}_${i}`}
                        type="button"
                        onClick={() =>
                          sendGotoCommand({
                            seriesId: ann.seriesId,
                            sliceIndex: ann.sliceIndex,
                            showAnnotations: true,
                          })
                        }
                        className="w-full text-left px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 flex items-center justify-between gap-1 cursor-pointer"
                      >
                        <span className="truncate">{ann.label}</span>
                        <span className="text-[10px] font-mono text-cyan-400 shrink-0">
                          #{ann.sliceIndex + 1}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Diagnostic intégré au .tpack (masqué par défaut pour l'entraînement, révélable en 1 clic) */}
              {activeCase.diagnosis && (
                <div className="space-y-2 pt-2 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !showDiagnosis;
                      setShowDiagnosis(next);
                      if (next) {
                        sendGotoCommand({
                          seriesId: activeCase.keySeriesId,
                          sliceIndex: activeCase.keySliceIndex,
                          windowKey: activeCase.keyWindowKey,
                          showAnnotations: true,
                        });
                      }
                    }}
                    className="w-full py-1.5 px-2.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    {showDiagnosis ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Masquer le diagnostic</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Révéler le diagnostic</span>
                      </>
                    )}
                  </button>

                  {showDiagnosis && (
                    <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-xs text-emerald-100 leading-snug">
                      {activeCase.diagnosis}
                    </div>
                  )}
                </div>
              )}
            </aside>
          )}
        </div>
      ) : (
        /* VUE 2 : CATALOGUE DE VOS FICHIERS .TPACK */
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {allCases.length === 0 ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="mt-12 border-2 border-dashed border-slate-800 hover:border-emerald-500/50 rounded-2xl p-10 flex flex-col items-center justify-center text-center gap-3 cursor-pointer bg-[#0B101B]/60 transition"
              >
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <Upload className="w-6 h-6" />
                </div>
                <div className="text-sm font-semibold text-white">
                  Glissez-déposez vos fichiers <code className="text-emerald-400">.tpack</code> ici
                </div>
                <p className="text-xs text-slate-400 max-w-sm">
                  Toutes les métadonnées (titre, clinique, diagnostic et annotations) sont lues
                  automatiquement depuis le fichier <code className="text-slate-300">.tpack</code>.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {(['ALL', 'CT', 'MR', 'CR', 'US'] as const).map((mod) => (
                    <button
                      key={mod}
                      type="button"
                      onClick={() => setFilterModality(mod)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                        filterModality === mod
                          ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {mod === 'ALL' ? `Tous (${allCases.length})` : mod}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredCases.map((c) => (
                    <div
                      key={`${c.source}_${c.id}`}
                      onClick={() => handleOpenCaseStudy(c)}
                      className="rounded-xl bg-[#0B101B] border border-slate-800 hover:border-cyan-500/50 p-4 flex flex-col justify-between gap-3 transition cursor-pointer group"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                              {c.modality}
                            </span>
                            {c.anatomicalRegion && (
                              <span className="text-xs text-slate-400">{c.anatomicalRegion}</span>
                            )}
                          </div>
                          <span className="text-[11px] text-slate-500 font-mono">
                            {(c.byteSize / 1024).toFixed(0)} Ko
                          </span>
                        </div>

                        <h2 className="text-sm font-bold text-white group-hover:text-cyan-300 transition">
                          {c.title}
                        </h2>
                        {c.clinicalHistory && (
                          <p className="text-xs text-slate-400 line-clamp-2">
                            {c.clinicalHistory}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-800/70">
                        <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1">
                          <Play className="w-3 h-3 fill-current" /> Ouvrir
                        </span>

                        <div
                          className="flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.tpackBytes && (
                            <button
                              type="button"
                              onClick={() => handleDownloadCaseTpack(c)}
                              className="p-1.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-300"
                              title="Télécharger .tpack"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {c.source === 'indexeddb' && (
                            <button
                              type="button"
                              onClick={async () => {
                                await deleteClinicalCaseFromIndexedDB(c.id);
                                await refreshCases();
                              }}
                              className="p-1.5 rounded bg-slate-900 hover:bg-red-950/60 text-slate-400 hover:text-red-300"
                              title="Supprimer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      )}
    </div>
  );
};

export default App;
