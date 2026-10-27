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
  ExternalLink,
  Database,
  Globe,
  Layers,
  Sparkles,
  FileJson,
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
const LOCAL_VIEWER_EMBED_URL = 'http://localhost:5174/?embed=1';

export const App: React.FC = () => {
  const [localCases, setLocalCases] = useState<ClinicalCaseItem[]>([]);
  const [publicCases, setPublicCases] = useState<ClinicalCaseItem[]>([]);
  const [activeCase, setActiveCase] = useState<ClinicalCaseItem | null>(null);
  const [filterModality, setFilterModality] = useState<string>('ALL');

  // Choix de la source du lecteur embarqué (Prod GitHub Pages auto-actualisé par défaut)
  const [useLocalDevViewer, setUseLocalDevViewer] = useState<boolean>(false);
  const viewerIframeRef = useRef<HTMLIFrameElement | null>(null);

  // État remonté en temps réel par le lecteur .tpack embarqué via postMessage
  const [viewerTelemetry, setViewerTelemetry] = useState<{
    sliceIndex: number;
    sliceCount: number;
    windowKey: string;
    seriesId: string;
  } | null>(null);

  // État du QCU dans la vue d'étude d'un cas
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);

  // Modal d'ajout / stockage d'un nouveau cas .tpack
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newTpackBytes, setNewTpackBytes] = useState<Uint8Array | null>(null);
  const [newManifest, setNewManifest] = useState<PedagogicalManifest | null>(null);
  const [newId, setNewId] = useState<string>('');
  const [newTitle, setNewTitle] = useState<string>('');
  const [newModality, setNewModality] = useState<"MR" | "CT" | "CR" | "DX" | "XA" | "US">('CT');
  const [newRegion, setNewRegion] = useState<string>('Thorax / Abdomen');
  const [newDifficulty, setNewDifficulty] = useState<"Débutant" | "Intermédiaire" | "Avancé">(
    'Intermédiaire'
  );
  const [newHistory, setNewHistory] = useState<string>('');
  const [newQuestion, setNewQuestion] = useState<string>(
    'Quelle anomalie principale identifiez-vous sur la coupe clé de cet examen ?'
  );
  const [newChoices, setNewChoices] = useState<string[]>([
    'Lésion focale caractéristique sur la coupe cible',
    'Examen strictement normal pour l’âge',
    'Artefact cinétique isolé',
    'Variante anatomique bénigne',
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

  // Envoie le cas actif au lecteur .tpack embarqué via postMessage
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
      // Positionne également la série correspondante si précisée
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
        }, 450);
      }
    }
  }, []);

  // Écoute les messages du lecteur .tpack embarqué (TPACK_EMBED_READY et TPACK_VIEWER_STATE)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'TPACK_EMBED_READY' && activeCase) {
        pushCaseToEmbeddedViewer(activeCase);
      } else if (data.type === 'TPACK_VIEWER_STATE') {
        setViewerTelemetry({
          sliceIndex: data.sliceIndex ?? 0,
          sliceCount: data.sliceCount ?? 1,
          windowKey: data.windowKey ?? 'default',
          seriesId: data.seriesId ?? '',
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeCase, pushCaseToEmbeddedViewer]);

  // Pilote le lecteur .tpack embarqué pour aller sur une coupe / fenêtre précise
  const sendGotoCommand = (opts: {
    sliceIndex?: number;
    windowKey?: string;
    seriesId?: string;
    showAnnotations?: boolean;
  }) => {
    const win = viewerIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        type: 'TPACK_GOTO',
        ...opts,
      },
      '*'
    );
  };

  const handleOpenCaseStudy = (c: ClinicalCaseItem) => {
    setActiveCase(c);
    setSelectedChoice(null);
    setIsSubmitted(false);
    setViewerTelemetry(null);
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
      setNewRegion(manifest.anatomicalRegion || 'Thorax / Abdomen');
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
      setUploadError('Veuillez d’abord sélectionner un fichier .tpack.');
      return;
    }

    const newItem: ClinicalCaseItem = {
      id: newId.trim() || `CAS-${Date.now()}`,
      title: newTitle.trim() || 'Nouveau Cas Clinique',
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

  const handleExportCatalogJson = () => {
    const cleanCatalog = allCases.map((c) => ({
      ...c,
      source: 'public_catalog',
      tpackUrl: c.tpackUrl || `./cases/${c.id.toLowerCase()}.tpack`,
      tpackBytes: undefined,
    }));
    const blob = new Blob([JSON.stringify(cleanCatalog, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'catalog.json';
    a.click();
    URL.revokeObjectURL(url);
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

  const embedBaseUrl = useLocalDevViewer ? LOCAL_VIEWER_EMBED_URL : PROD_VIEWER_EMBED_URL;

  return (
    <div className="min-h-[100dvh] w-full flex flex-col bg-[#090D16] text-slate-100">
      {/* BARRE DE NAVIGATION DU PORTAIL DE CAS PÉDAGOGIQUES */}
      <header className="h-12 shrink-0 bg-[#090D16] border-b border-slate-800/90 px-3 sm:px-6 flex items-center justify-between gap-2 sticky top-0 z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          {activeCase ? (
            <button
              type="button"
              onClick={() => setActiveCase(null)}
              className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-cyan-300 flex items-center gap-1.5 transition cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Catalogue</span>
            </button>
          ) : (
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <BookOpen className="w-4 h-4" />
            </div>
          )}

          <div className="truncate">
            <div className="flex items-center gap-2">
              <span className="font-bold text-xs sm:text-sm tracking-tight text-white">
                TPack<span className="text-emerald-400">.cases</span>
              </span>
              <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-[10px] font-medium text-cyan-300">
                <Sparkles className="w-3 h-3" />
                Lecteur .tpack Synchronisé en Direct
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Stocker un Cas .tpack</span>
          </button>

          <a
            href="https://mrthomaslef.github.io/dicomviewer/"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-cyan-300 items-center gap-1.5 transition"
            title="Ouvrir le Studio de Compression DICOM -> .tpack"
          >
            <span>Studio .tpack</span>
            <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
          </a>
        </div>
      </header>

      {/* VUE 1 : ÉTUDE D'UN CAS CLINIQUE (Lecteur .tpack embarqué + Dossier & Quiz) */}
      {activeCase ? (
        <div className="flex-1 flex flex-col lg:flex-row h-[calc(100dvh-3rem)] overflow-hidden">
          {/* ZONE GAUCHE / HAUT : Lecteur .tpack officiel synchronisé via iframe (?embed=1) */}
          <div className="w-full h-[54dvh] lg:h-full lg:flex-1 bg-[#090D16] relative border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col">
            <iframe
              ref={viewerIframeRef}
              src={embedBaseUrl}
              title={`Lecteur .tpack — ${activeCase.title}`}
              className="w-full flex-1 border-0 block bg-[#090D16]"
              allow="fullscreen"
              onLoad={() => pushCaseToEmbeddedViewer(activeCase)}
            />

            {/* Barre d'état de synchronisation du lecteur partagé */}
            <div className="h-8 bg-[#0B101B] border-t border-slate-800/80 px-3 flex items-center justify-between text-[11px] text-slate-400 shrink-0">
              <div className="flex items-center gap-2 truncate">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="truncate">
                  Moteur :{' '}
                  <code className="text-cyan-300">
                    {useLocalDevViewer
                      ? 'localhost:5174/?embed=1'
                      : 'mrthomaslef.github.io/dicomviewer/?embed=1'}
                  </code>
                </span>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {viewerTelemetry && (
                  <span className="font-mono text-cyan-300">
                    Coupe {viewerTelemetry.sliceIndex + 1}/{viewerTelemetry.sliceCount} •{' '}
                    {viewerTelemetry.windowKey}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setUseLocalDevViewer((v) => !v)}
                  className="text-[10px] underline text-slate-400 hover:text-cyan-300 cursor-pointer"
                >
                  {useLocalDevViewer ? 'Basculer sur Prod GitHub' : 'Tester sur Localhost:5174'}
                </button>
              </div>
            </div>
          </div>

          {/* ZONE DROITE / BAS : Dossier Clinique, Pilotage Coupe Clé & QCU Pédagogique */}
          <div className="w-full lg:w-[430px] xl:w-[480px] flex-1 lg:h-full bg-[#0B101B] overflow-y-auto p-4 sm:p-5 space-y-5 shrink-0">
            {/* En-tête du Cas */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-xs">
                  {activeCase.modality}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-xs">
                  {activeCase.anatomicalRegion}
                </span>
                <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-xs font-medium">
                  {activeCase.difficulty}
                </span>
              </div>
              <h1 className="text-base sm:text-lg font-bold text-white leading-snug">
                {activeCase.title}
              </h1>
            </div>

            {/* Histoire Clinique */}
            <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Renseignements Cliniques
              </div>
              <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
                {activeCase.clinicalHistory}
              </p>
            </div>

            {/* Raccourcis de Pilotage Direct du Lecteur .tpack via postMessage */}
            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/90 space-y-2.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <Crosshair className="w-3.5 h-3.5" />
                <span>Navigation Guidée sur le Lecteur .tpack</span>
              </div>
              <div className="flex flex-wrap gap-2">
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
                  className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
                  Aller à la Coupe Clé (#{activeCase.keySliceIndex + 1})
                </button>

                {activeCase.modality === 'CT' && (
                  <>
                    <button
                      type="button"
                      onClick={() => sendGotoCommand({ windowKey: 'soft' })}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition cursor-pointer"
                    >
                      Fenêtre Parties Molles
                    </button>
                    <button
                      type="button"
                      onClick={() => sendGotoCommand({ windowKey: 'bone' })}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition cursor-pointer"
                    >
                      Fenêtre Osseuse
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Question Pédagogique (QCU) */}
            <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-amber-400">
                Question Diagnostique
              </div>
              <p className="text-xs sm:text-sm font-medium text-white leading-relaxed">
                {activeCase.question}
              </p>

              <div className="space-y-2 pt-1">
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
                      className={`w-full text-left p-3 rounded-xl border text-xs sm:text-sm flex items-start justify-between gap-2 transition cursor-pointer ${btnStyle}`}
                    >
                      <span>{choice}</span>
                      {isSubmitted && isCorrect && (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      )}
                      {isSubmitted && isSelected && !isCorrect && (
                        <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
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
                  className="w-full mt-2 py-2.5 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 font-semibold text-xs transition cursor-pointer"
                >
                  Valider ma réponse &amp; Afficher la coupe clé
                </button>
              ) : (
                <div className="mt-3 p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/40 space-y-2">
                  <div className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Correction Radiologique Commentée</span>
                  </div>
                  <p className="text-xs text-slate-200 leading-relaxed">
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
                    Réessayer la question
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* VUE 2 : CATALOGUE DE CAS CLINIQUES (.tpack) */
        <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
          {/* Bannière d'explication de l'architecture synchronisée */}
          <div className="rounded-2xl bg-gradient-to-r from-slate-900 via-[#0B101B] to-slate-900 border border-slate-800 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-400">
                <Layers className="w-4 h-4" />
                <span>Architecture Zéro-Serveur &amp; Lecteur .tpack Partagé</span>
              </div>
              <h1 className="text-lg sm:text-xl font-bold text-white">
                Banque de Cas Pédagogiques d&apos;Imagerie Médicale
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 max-w-2xl">
                Ce site utilise directement le moteur de lecture{' '}
                <code className="text-cyan-300">mrthomaslef.github.io/dicomviewer</code>. Toute
                amélioration d&apos;ergonomie poussée sur le lecteur s&apos;applique instantanément
                à tous vos cas cliniques stockés ici.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleExportCatalogJson}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition cursor-pointer"
                title="Exporter le fichier catalog.json pour public/cases/"
              >
                <FileJson className="w-4 h-4 text-cyan-400" />
                <span>Exporter catalog.json</span>
              </button>
            </div>
          </div>

          {/* Barre de filtres par modalité */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(['ALL', 'CT', 'MR', 'CR', 'US'] as const).map((mod) => (
                <button
                  key={mod}
                  type="button"
                  onClick={() => setFilterModality(mod)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                    filterModality === mod
                      ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {mod === 'ALL' ? `Tous les cas (${allCases.length})` : mod}
                </button>
              ))}
            </div>
          </div>

          {/* Grille des Cas Cliniques */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredCases.map((c) => (
              <div
                key={`${c.source}_${c.id}`}
                className="rounded-2xl bg-[#0B101B] border border-slate-800 hover:border-cyan-500/40 p-5 flex flex-col justify-between gap-4 transition shadow-lg"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-xs">
                        {c.modality}
                      </span>
                      <span className="text-xs text-slate-400 font-mono">{c.id}</span>
                      <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px] text-slate-300">
                        {c.difficulty}
                      </span>
                    </div>

                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 ${
                        c.source === 'indexeddb'
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                      }`}
                    >
                      {c.source === 'indexeddb' ? (
                        <>
                          <Database className="w-3 h-3" /> IndexedDB Local
                        </>
                      ) : (
                        <>
                          <Globe className="w-3 h-3" /> Catalogue GitHub
                        </>
                      )}
                    </span>
                  </div>

                  <h2 className="text-base font-bold text-white leading-snug">{c.title}</h2>
                  <div className="text-xs text-cyan-300">
                    Région : {c.anatomicalRegion} • Coupe clé : #{c.keySliceIndex + 1} •{' '}
                    {(c.byteSize / 1024).toFixed(0)} Ko
                  </div>
                  <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed">
                    {c.clinicalHistory}
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => handleOpenCaseStudy(c)}
                    className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 shadow-md shadow-cyan-500/10 transition cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Étudier ce Cas (.tpack)
                  </button>

                  <div className="flex items-center gap-1.5">
                    {c.tpackBytes && (
                      <button
                        type="button"
                        onClick={() => handleDownloadCaseTpack(c)}
                        className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-cyan-300 transition cursor-pointer"
                        title="Télécharger le fichier .tpack pour l'héberger dans public/cases/"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}

                    {c.source === 'indexeddb' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await deleteClinicalCaseFromIndexedDB(c.id);
                          await refreshCases();
                        }}
                        className="p-2 rounded-lg bg-slate-900 hover:bg-red-950/60 border border-slate-800 hover:border-red-500/40 text-slate-400 hover:text-red-300 transition cursor-pointer"
                        title="Supprimer ce cas du stockage local IndexedDB"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* MODAL D'AJOUT / STOCKAGE D'UN CAS .TPACK */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="bg-[#0B101B] border border-slate-800 rounded-2xl max-w-xl w-full p-5 space-y-4 shadow-2xl my-8 max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-sm font-bold text-emerald-400">
                <Upload className="w-4 h-4" />
                <span>Stocker un Nouveau Cas Pédagogique (.tpack)</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveNewCase} className="space-y-3 text-xs">
              {/* Sélection du fichier .tpack */}
              <label className="block border-2 border-dashed border-cyan-500/40 hover:border-cyan-400 rounded-xl p-4 text-center cursor-pointer bg-slate-900/50 transition">
                <input
                  type="file"
                  accept=".tpack,.zip"
                  className="hidden"
                  onChange={(e) =>
                    e.target.files?.[0] && handleSelectNewTpackFile(e.target.files[0])
                  }
                />
                <div className="text-cyan-300 font-semibold">
                  {newTpackBytes
                    ? `Fichier .tpack chargé (${(newTpackBytes.byteLength / 1024).toFixed(
                        0
                      )} Ko) — ${newManifest?.series.length || 1} série(s)`
                    : 'Cliquez ou glissez votre fichier .tpack exporté depuis TPack Studio'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Le manifest.json interne est lu automatiquement pour pré-remplir la fiche.
                </div>
              </label>

              {uploadError && (
                <div className="p-2.5 rounded-lg bg-red-950/70 border border-red-500/40 text-red-200">
                  {uploadError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-slate-400 block mb-1">Identifiant du Cas</label>
                  <input
                    type="text"
                    required
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    placeholder="CAS-TDM-01"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Difficulté</label>
                  <select
                    value={newDifficulty}
                    onChange={(e) =>
                      setNewDifficulty(
                        e.target.value as "Débutant" | "Intermédiaire" | "Avancé"
                      )
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                  >
                    <option value="Débutant">Débutant</option>
                    <option value="Intermédiaire">Intermédiaire</option>
                    <option value="Avancé">Avancé</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Titre du Cas Clinique</label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-slate-400 block mb-1">Coupe Clé (numéro)</label>
                  <input
                    type="number"
                    min={1}
                    value={newKeySlice1Based}
                    onChange={(e) => setNewKeySlice1Based(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Fenêtre Clé (soft / bone / default)</label>
                  <input
                    type="text"
                    value={newKeyWindow}
                    onChange={(e) => setNewKeyWindow(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Histoire Clinique</label>
                <textarea
                  rows={2}
                  value={newHistory}
                  onChange={(e) => setNewHistory(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Question Diagnostique (QCU)</label>
                <input
                  type="text"
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-400 block">
                  Propositions de réponse (cochez la bonne réponse)
                </label>
                {newChoices.map((ch, idx) => (
                  <div key={idx} className="flex items-center gap-2">
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
                      className="flex-1 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                    />
                  </div>
                ))}
              </div>

              <div>
                <label className="text-slate-400 block mb-1">
                  Explication &amp; Correction Radiologique
                </label>
                <textarea
                  rows={2}
                  value={newExplanation}
                  onChange={(e) => setNewExplanation(e.target.value)}
                  placeholder="Détaillez la sémiologie radiologique sur la coupe clé..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 text-slate-300 font-medium"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
                >
                  Enregistrer le Cas (.tpack)
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
