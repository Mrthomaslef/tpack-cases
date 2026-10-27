import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BookOpen,
  Plus,
  Play,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Crosshair,
  Upload,
  Trash2,
  Download,
  PanelRightClose,
  PanelRightOpen,
  HelpCircle,
  X,
} from 'lucide-react';
import { ClinicalCaseItem, PedagogicalManifest } from './types';
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

  // Panneau droit pliable (ouvert par défaut sur desktop, repliable en 1 clic)
  const [isSidePanelOpen, setIsSidePanelOpen] = useState<boolean>(true);
  const viewerIframeRef = useRef<HTMLIFrameElement | null>(null);

  // QCU
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);

  // Modal ajout cas .tpack
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newTpackBytes, setNewTpackBytes] = useState<Uint8Array | null>(null);
  const [newManifest, setNewManifest] = useState<PedagogicalManifest | null>(null);
  const [newId, setNewId] = useState<string>('');
  const [newTitle, setNewTitle] = useState<string>('');
  const [newModality, setNewModality] = useState<"MR" | "CT" | "CR" | "DX" | "XA" | "US">('CT');
  const [newRegion, setNewRegion] = useState<string>('Abdomen');
  const [newDifficulty, setNewDifficulty] = useState<"Débutant" | "Intermédiaire" | "Avancé">(
    'Intermédiaire'
  );
  const [newHistory, setNewHistory] = useState<string>('');
  const [newQuestion, setNewQuestion] = useState<string>('Quel est le diagnostic ?');
  const [newChoices, setNewChoices] = useState<string[]>([
    'Lésion cible',
    'Normal',
    'Artefact',
    'Variante',
  ]);
  const [newCorrectIdx, setNewCorrectIdx] = useState<number>(0);
  const [newExplanation, setNewExplanation] = useState<string>('');
  const [newKeySlice1Based, setNewKeySlice1Based] = useState<number>(13);
  const [newKeyWindow, setNewKeyWindow] = useState<string>('soft');
  const [uploadError, setUploadError] = useState<string | null>(null);

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
    } else {
      win.postMessage({ type: 'TPACK_LOAD_DEMO' }, '*');
      if (caseItem.keySeriesId) {
        setTimeout(() => {
          win.postMessage(
            {
              type: 'TPACK_GOTO',
              seriesId: caseItem.keySeriesId,
              windowKey: caseItem.keyWindowKey,
              sliceIndex: caseItem.keySliceIndex,
            },
            '*'
          );
        }, 400);
      }
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
    setSelectedChoice(null);
    setIsSubmitted(false);
    // Sur mobile, replie le panneau par défaut pour laisser toute l'image visible d'emblée
    setIsSidePanelOpen(window.innerWidth >= 768);
  };

  const handleSelectNewTpackFile = async (file: File) => {
    setUploadError(null);
    try {
      const { manifest, bytes } = await inspectTPackFile(file);
      setNewTpackBytes(bytes);
      setNewManifest(manifest);
      setNewId(manifest.caseId || `CAS-${Date.now()}`);
      setNewTitle(manifest.title || file.name.replace(/\.tpack$/i, ''));
      setNewModality(manifest.modality || 'CT');
      setNewRegion(manifest.anatomicalRegion || 'Abdomen');
      setNewHistory(manifest.clinicalHistory || '');
      const firstSeries = manifest.series[0];
      if (firstSeries) {
        setNewKeySlice1Based(Math.max(1, Math.ceil(firstSeries.sliceCount / 2)));
        setNewKeyWindow(firstSeries.availableWindows[0]?.key || 'default');
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Fichier .tpack invalide');
    }
  };

  const handleSaveNewCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTpackBytes) {
      setUploadError('Sélectionnez un fichier .tpack.');
      return;
    }

    const newItem: ClinicalCaseItem = {
      id: newId.trim() || `CAS-${Date.now()}`,
      title: newTitle.trim() || 'Cas Clinique',
      modality: newModality,
      anatomicalRegion: newRegion.trim() || 'Général',
      difficulty: newDifficulty,
      clinicalHistory: newHistory.trim(),
      question: newQuestion.trim(),
      choices: newChoices.map((c) => c.trim()).filter(Boolean),
      correctChoiceIndex: newCorrectIdx,
      explanation: newExplanation.trim(),
      keySliceIndex: Math.max(0, newKeySlice1Based - 1),
      keyWindowKey: newKeyWindow,
      keySeriesId: newManifest?.series[0]?.id,
      createdAt: new Date().toISOString(),
      byteSize: newTpackBytes.byteLength,
      source: 'indexeddb',
      tpackBytes: newTpackBytes,
      manifest: newManifest || undefined,
    };

    await saveClinicalCaseToIndexedDB(newItem);
    await refreshCases();
    setShowAddModal(false);
    setNewTpackBytes(null);
    setNewManifest(null);
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
    <div className="h-[100dvh] w-screen flex flex-col bg-[#090D16] text-slate-100 overflow-hidden">
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
              <span>Cas</span>
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
          {activeCase ? (
            <button
              type="button"
              onClick={() => setIsSidePanelOpen((v) => !v)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition cursor-pointer ${
                isSidePanelOpen
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-cyan-500/50'
              }`}
              title="Afficher / Masquer le panneau Question & Infos"
            >
              {isSidePanelOpen ? (
                <>
                  <PanelRightClose className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Masquer Quiz</span>
                </>
              ) : (
                <>
                  <PanelRightOpen className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Question / Infos</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center gap-1 transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Ajouter .tpack</span>
            </button>
          )}
        </div>
      </header>

      {/* VUE 1 : LECTEUR PLEIN ÉCRAN + VOLET DROIT PLIABLE (FOLDABLE) & ÉTROIT */}
      {activeCase ? (
        <div className="flex-1 min-h-0 w-full flex relative overflow-hidden">
          {/* ZONE DU LECTEUR .TPACK (100% de l'espace restant, dimensionnement absolu strict) */}
          <div className="relative flex-1 min-w-0 min-h-0 h-full bg-[#090D16]">
            <iframe
              ref={viewerIframeRef}
              src={PROD_VIEWER_EMBED_URL}
              title={activeCase.title}
              className="absolute inset-0 w-full h-full border-0 block bg-[#090D16]"
              allow="fullscreen"
              onLoad={() => pushCaseToEmbeddedViewer(activeCase)}
            />

            {/* Bouton flottant rapide pour rouvrir le quiz quand le volet est replié */}
            {!isSidePanelOpen && (
              <button
                type="button"
                onClick={() => setIsSidePanelOpen(true)}
                className="absolute top-2.5 right-24 z-20 px-2.5 py-1 rounded-lg bg-cyan-500 text-slate-950 font-bold text-xs flex items-center gap-1 shadow-lg cursor-pointer"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>Quiz</span>
              </button>
            )}
          </div>

          {/* VOLET DROIT PLIABLE & COMPACT (280px sur desktop, tiroir superposé sur mobile) */}
          {isSidePanelOpen && (
            <aside className="w-72 sm:w-80 h-full bg-[#0B101B]/95 backdrop-blur-md border-l border-slate-800 p-3.5 overflow-y-auto flex flex-col gap-3 z-30 absolute right-0 top-0 bottom-0 md:static shrink-0 shadow-2xl">
              {/* Entête du volet avec bouton Replier */}
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <div className="flex items-center gap-1.5">
                  <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                    {activeCase.modality}
                  </span>
                  <span className="text-xs font-semibold text-slate-300">
                    {activeCase.anatomicalRegion}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSidePanelOpen(false)}
                  className="p-1 rounded text-slate-400 hover:text-white cursor-pointer"
                  title="Replier le panneau"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>

              {/* Contexte clinique court */}
              <p className="text-xs text-slate-300 leading-snug bg-slate-900/70 p-2.5 rounded-lg border border-slate-800/80">
                {activeCase.clinicalHistory}
              </p>

              {/* Bouton accès rapide coupe clé */}
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
                <span>Voir Coupe Clé (#{activeCase.keySliceIndex + 1})</span>
              </button>

              {/* Question QCU compacte */}
              <div className="space-y-2 pt-1 border-t border-slate-800/80">
                <div className="text-xs font-semibold text-white leading-snug">
                  {activeCase.question}
                </div>

                <div className="space-y-1.5">
                  {activeCase.choices.map((choice, idx) => {
                    const isSelected = selectedChoice === idx;
                    const isCorrect = idx === activeCase.correctChoiceIndex;

                    let btnStyle =
                      'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700';
                    if (isSubmitted) {
                      if (isCorrect) {
                        btnStyle =
                          'bg-emerald-950/70 border-emerald-500/60 text-emerald-200 font-semibold';
                      } else if (isSelected && !isCorrect) {
                        btnStyle = 'bg-red-950/70 border-red-500/60 text-red-200';
                      }
                    } else if (isSelected) {
                      btnStyle = 'bg-cyan-500/20 border-cyan-400 text-cyan-100 font-semibold';
                    }

                    return (
                      <button
                        key={idx}
                        type="button"
                        disabled={isSubmitted}
                        onClick={() => setSelectedChoice(idx)}
                        className={`w-full text-left px-2.5 py-2 rounded-lg border text-xs flex items-center justify-between gap-1.5 transition cursor-pointer ${btnStyle}`}
                      >
                        <span className="leading-snug">{choice}</span>
                        {isSubmitted && isCorrect && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        )}
                        {isSubmitted && isSelected && !isCorrect && (
                          <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {!isSubmitted ? (
                  <button
                    type="button"
                    disabled={selectedChoice === null}
                    onClick={() => {
                      setIsSubmitted(true);
                      sendGotoCommand({
                        seriesId: activeCase.keySeriesId,
                        sliceIndex: activeCase.keySliceIndex,
                        windowKey: activeCase.keyWindowKey,
                        showAnnotations: true,
                      });
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 font-semibold text-xs transition cursor-pointer"
                  >
                    Valider
                  </button>
                ) : (
                  <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 space-y-1.5">
                    <p className="text-xs text-slate-200 leading-snug">
                      {activeCase.explanation}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setIsSubmitted(false);
                        setSelectedChoice(null);
                      }}
                      className="text-[11px] text-cyan-300 underline cursor-pointer"
                    >
                      Réessayer
                    </button>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      ) : (
        /* VUE 2 : CATALOGUE ÉPURÉ */
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {/* Filtres rapides */}
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

            {/* Grille de cartes minimalistes */}
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
                        <span className="text-xs text-slate-400">{c.anatomicalRegion}</span>
                      </div>
                      <span className="text-[11px] text-slate-500">{c.difficulty}</span>
                    </div>

                    <h2 className="text-sm font-bold text-white group-hover:text-cyan-300 transition">
                      {c.title}
                    </h2>
                    <p className="text-xs text-slate-400 line-clamp-2">{c.clinicalHistory}</p>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/70">
                    <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1">
                      <Play className="w-3 h-3 fill-current" /> Ouvrir le cas
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
          </div>
        </main>
      )}

      {/* MODAL D'AJOUT DE CAS .TPACK */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="bg-[#0B101B] border border-slate-800 rounded-2xl max-w-md w-full p-4 space-y-3 shadow-2xl max-h-[88dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                <Upload className="w-3.5 h-3.5" />
                <span>Ajouter un Cas (.tpack)</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveNewCase} className="space-y-2.5 text-xs">
              <label className="block border border-dashed border-cyan-500/40 hover:border-cyan-400 rounded-xl p-3 text-center cursor-pointer bg-slate-900/50">
                <input
                  type="file"
                  accept=".tpack,.zip"
                  className="hidden"
                  onChange={(e) =>
                    e.target.files?.[0] && handleSelectNewTpackFile(e.target.files[0])
                  }
                />
                <span className="text-cyan-300 font-semibold">
                  {newTpackBytes
                    ? `Fichier chargé (${(newTpackBytes.byteLength / 1024).toFixed(0)} Ko)`
                    : 'Sélectionner un fichier .tpack'}
                </span>
              </label>

              {uploadError && (
                <div className="p-2 rounded bg-red-950/70 text-red-200">{uploadError}</div>
              )}

              <input
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Titre du cas"
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
              />

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min={1}
                  value={newKeySlice1Based}
                  onChange={(e) => setNewKeySlice1Based(Number(e.target.value))}
                  placeholder="Coupe clé"
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
                <input
                  type="text"
                  value={newKeyWindow}
                  onChange={(e) => setNewKeyWindow(e.target.value)}
                  placeholder="Fenêtre (soft/bone)"
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <textarea
                rows={2}
                value={newHistory}
                onChange={(e) => setNewHistory(e.target.value)}
                placeholder="Contexte clinique court"
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
              />

              <input
                type="text"
                value={newQuestion}
                onChange={(e) => setNewQuestion(e.target.value)}
                placeholder="Question"
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
              />

              <div className="space-y-1">
                {newChoices.map((ch, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="correctChoice"
                      checked={newCorrectIdx === idx}
                      onChange={() => setNewCorrectIdx(idx)}
                      className="accent-emerald-400"
                    />
                    <input
                      type="text"
                      value={ch}
                      onChange={(e) => {
                        const copy = [...newChoices];
                        copy[idx] = e.target.value;
                        setNewChoices(copy);
                      }}
                      className="flex-1 px-2 py-1 rounded bg-slate-950 border border-slate-800 text-slate-100"
                    />
                  </div>
                ))}
              </div>

              <textarea
                rows={2}
                value={newExplanation}
                onChange={(e) => setNewExplanation(e.target.value)}
                placeholder="Correction courte"
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
              />

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-semibold cursor-pointer"
                >
                  Enregistrer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
