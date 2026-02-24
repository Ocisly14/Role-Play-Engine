import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  TUTORIAL_DEMO_INPUT,
  TUTORIAL_SCENE_TRANSITION_INPUT,
  getTutorialSeenStorageKey,
} from "../constants/tutorial";
import { useAuth } from "../contexts/AuthContext";
import { setBackgroundWithTransition } from "../utils/backgroundTransition";
import { findAvailableImage } from "../utils/imageLoader";

type TutorialFocus =
  | "message-intro"
  | "message-demo"
  | "sidebar-status"
  | "fatigue"
  | "rest-button"
  | "rest-panel"
  | "scene-transition-input"
  | "scene-transition-result"
  | "knowledge"
  | "map"
  | "map-updated";

type SidebarTab = "status" | "notes" | "knowledge" | "map";

interface TutorialStep {
  focus: TutorialFocus;
  title: string;
  description: string;
}

type BubblePlacement = "top" | "bottom" | "left" | "right";

interface BubblePosition {
  top: number;
  left: number;
  placement: BubblePlacement;
  arrowOffset: number;
}

const TUTORIAL_DEFAULT_BACKGROUND =
  "/tutorial/Azure_Kave_Resort_Overwater_Bungalow_Cluster_Day_1_09_30_mlspye6y_6cyu.png";
const TUTORIAL_SCENE_TRANSITION_BACKGROUND =
  "/tutorial/Seaplane_Dock_Approach_Corridor_Day_1_09_50_mm08auyy_xujv.jpg";

export const TutorialPage: React.FC = () => {
  const { t } = useTranslation("game");
  const navigate = useNavigate();
  const { user } = useAuth();

  const [stepIndex, setStepIndex] = useState(0);
  const [typedInput, setTypedInput] = useState("");
  const [restModalOpen, setRestModalOpen] = useState(false);
  const [restSelectedHours, setRestSelectedHours] = useState<number | null>(
    null
  );
  const [restCustomHours, setRestCustomHours] = useState("");
  const [restShowCustomInput, setRestShowCustomInput] = useState(false);
  const [sceneTransitionReplyReady, setSceneTransitionReplyReady] =
    useState(false);
  const guideCardRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollAreaRef = useRef<HTMLDivElement | null>(null);
  const restCustomInputRef = useRef<HTMLInputElement | null>(null);
  const sceneTransitionReplyTimerRef = useRef<number | null>(null);
  const sceneTransitionAutoScrollPlayedRef = useRef(false);
  const focusRefs = useRef<Partial<Record<TutorialFocus, HTMLElement | null>>>(
    {}
  );
  const [bubblePosition, setBubblePosition] = useState<BubblePosition>({
    top: 16,
    left: 16,
    placement: "bottom",
    arrowOffset: 40,
  });

  const steps = useMemo<TutorialStep[]>(
    () => [
      {
        focus: "message-intro",
        title: t("tutorial.steps.message.title"),
        description: t("tutorial.steps.message.description"),
      },
      {
        focus: "message-demo",
        title: t("tutorial.steps.messageDemo.title"),
        description: t("tutorial.steps.messageDemo.description"),
      },
      {
        focus: "sidebar-status",
        title: t("tutorial.steps.sidebar.title"),
        description: t("tutorial.steps.sidebar.description"),
      },
      {
        focus: "fatigue",
        title: t("tutorial.steps.fatigue.title"),
        description: t("tutorial.steps.fatigue.description"),
      },
      {
        focus: "rest-button",
        title: t("tutorial.steps.restButton.title"),
        description: t("tutorial.steps.restButton.description"),
      },
      {
        focus: "rest-panel",
        title: t("tutorial.steps.restPanel.title"),
        description: t("tutorial.steps.restPanel.description"),
      },
      {
        focus: "scene-transition-input",
        title: t("tutorial.steps.sceneTransitionInput.title"),
        description: t("tutorial.steps.sceneTransitionInput.description"),
      },
      {
        focus: "scene-transition-result",
        title: t("tutorial.steps.sceneTransitionResult.title"),
        description: t("tutorial.steps.sceneTransitionResult.description"),
      },
      {
        focus: "knowledge",
        title: t("tutorial.steps.knowledge.title"),
        description: t("tutorial.steps.knowledge.description"),
      },
      {
        focus: "map",
        title: t("tutorial.steps.map.title"),
        description: t("tutorial.steps.map.description"),
      },
      {
        focus: "map-updated",
        title: t("tutorial.steps.mapUpdated.title"),
        description: t("tutorial.steps.mapUpdated.description"),
      },
    ],
    [t]
  );

  const currentStep = steps[stepIndex] ?? steps[0];
  const isLastStep = stepIndex >= steps.length - 1;
  const messageDemoStepIndex = steps.findIndex(
    (step) => step.focus === "message-demo"
  );
  const sceneTransitionInputStepIndex = steps.findIndex(
    (step) => step.focus === "scene-transition-input"
  );
  const sceneTransitionResultStepIndex = steps.findIndex(
    (step) => step.focus === "scene-transition-result"
  );
  const fatigueStepIndex = steps.findIndex((step) => step.focus === "fatigue");
  const showFatigue = fatigueStepIndex >= 0 && stepIndex >= fatigueStepIndex;
  const showRestPanelStep = currentStep.focus === "rest-panel";
  const showSceneTransitionMock =
    sceneTransitionResultStepIndex >= 0 &&
    stepIndex >= sceneTransitionResultStepIndex;
  const showSuggestedSkills =
    messageDemoStepIndex >= 0 &&
    stepIndex >= messageDemoStepIndex &&
    (sceneTransitionInputStepIndex < 0 ||
      stepIndex < sceneTransitionInputStepIndex);
  const hasSceneTransitionCompleted =
    sceneTransitionResultStepIndex >= 0 &&
    stepIndex >= sceneTransitionResultStepIndex;
  const tutorialStatusLocation = hasSceneTransitionCompleted
    ? "水上飞机码头 A港口"
    : "水屋接待处";
  const tutorialStatusTime = hasSceneTransitionCompleted ? "9：05" : "9：00";
  const tutorialMapSceneName = hasSceneTransitionCompleted
    ? "水上飞机码头"
    : "水屋接待处";
  const tutorialMapLocation = hasSceneTransitionCompleted
    ? "水上飞机码头 A港口"
    : "水屋接待处";
  const isInputCollapsedInTutorial =
    sceneTransitionResultStepIndex >= 0 &&
    stepIndex >= sceneTransitionResultStepIndex;
  const isMessageFocused =
    currentStep.focus === "message-intro" ||
    currentStep.focus === "message-demo" ||
    currentStep.focus === "scene-transition-input";

  const activeSidebarTab: SidebarTab =
    currentStep.focus === "knowledge"
      ? "knowledge"
      : currentStep.focus === "map" || currentStep.focus === "map-updated"
        ? "map"
        : "status";

  const markTutorialSeen = () => {
    window.localStorage.setItem(getTutorialSeenStorageKey(user?.email), "1");
  };

  const handleExit = () => {
    markTutorialSeen();
    navigate("/");
  };

  const handleNext = () => {
    if (isLastStep) {
      handleExit();
      return;
    }
    setStepIndex((prev) => prev + 1);
  };

  const handlePrevious = () => {
    setStepIndex((prev) => Math.max(0, prev - 1));
  };

  const openRestModal = useCallback(() => {
    setRestModalOpen(true);
    setRestSelectedHours(null);
    setRestShowCustomInput(false);
    setRestCustomHours("");
  }, []);

  const closeRestModal = useCallback(() => {
    setRestModalOpen(false);
    setRestSelectedHours(null);
    setRestShowCustomInput(false);
    setRestCustomHours("");
  }, []);

  const handleRestConfirm = useCallback(() => {
    const selectedHours = restShowCustomInput
      ? Number(restCustomHours)
      : restSelectedHours;
    if (
      !selectedHours ||
      Number.isNaN(selectedHours) ||
      selectedHours < 1 ||
      selectedHours > 24
    ) {
      return;
    }

    closeRestModal();
  }, [restShowCustomInput, restCustomHours, restSelectedHours, closeRestModal]);

  const isRestConfirmDisabled = restShowCustomInput
    ? !restCustomHours ||
      Number(restCustomHours) < 1 ||
      Number(restCustomHours) > 24
    : restSelectedHours === null;

  useEffect(() => {
    const isMessageDemoStep = currentStep.focus === "message-demo";
    const isSceneTransitionInputStep =
      currentStep.focus === "scene-transition-input";
    const isSceneTransitionResultStep =
      currentStep.focus === "scene-transition-result";

    if (isSceneTransitionResultStep) {
      setTypedInput("");
      return;
    }

    if (!isMessageDemoStep && !isSceneTransitionInputStep) {
      if (
        sceneTransitionResultStepIndex >= 0 &&
        stepIndex >= sceneTransitionResultStepIndex
      ) {
        setTypedInput("");
      } else if (messageDemoStepIndex >= 0 && stepIndex > messageDemoStepIndex) {
        setTypedInput(TUTORIAL_DEMO_INPUT);
      } else {
        setTypedInput("");
      }
      return;
    }

    const textToType = isSceneTransitionInputStep
      ? TUTORIAL_SCENE_TRANSITION_INPUT
      : TUTORIAL_DEMO_INPUT;
    const typingStepIndex = isSceneTransitionInputStep
      ? sceneTransitionInputStepIndex
      : messageDemoStepIndex;

    if (typingStepIndex < 0) {
      setTypedInput(textToType);
      return;
    }

    setTypedInput("");
    let index = 0;
    const timerId = window.setInterval(() => {
      index += 1;
      setTypedInput(textToType.slice(0, index));
      if (index >= textToType.length) {
        window.clearInterval(timerId);
      }
    }, 80);

    return () => window.clearInterval(timerId);
  }, [
    currentStep.focus,
    messageDemoStepIndex,
    sceneTransitionInputStepIndex,
    sceneTransitionResultStepIndex,
    stepIndex,
  ]);

  useEffect(() => {
    if (currentStep.focus !== "scene-transition-result") {
      return;
    }
    setSceneTransitionReplyReady(false);
    if (sceneTransitionReplyTimerRef.current !== null) {
      window.clearTimeout(sceneTransitionReplyTimerRef.current);
    }
    sceneTransitionReplyTimerRef.current = window.setTimeout(() => {
      setSceneTransitionReplyReady(true);
      sceneTransitionReplyTimerRef.current = null;
    }, 700);
  }, [currentStep.focus]);

  useEffect(() => {
    if (currentStep.focus === "rest-panel") {
      openRestModal();
    }
  }, [currentStep.focus, openRestModal]);

  useEffect(() => {
    if (currentStep.focus !== "rest-panel" && restModalOpen) {
      closeRestModal();
    }
  }, [currentStep.focus, restModalOpen, closeRestModal]);

  useEffect(() => {
    const shouldUseSceneTransitionBackground =
      sceneTransitionResultStepIndex >= 0 &&
      stepIndex >= sceneTransitionResultStepIndex;
    setBackgroundWithTransition(
      shouldUseSceneTransitionBackground
        ? TUTORIAL_SCENE_TRANSITION_BACKGROUND
        : TUTORIAL_DEFAULT_BACKGROUND,
      true
    );
  }, [sceneTransitionResultStepIndex, stepIndex]);

  useEffect(() => {
    return () => {
      const restoreDefaultBackground = async () => {
        try {
          const defaultImage = await findAvailableImage("background");
          setBackgroundWithTransition(defaultImage, true);
        } catch {
          setBackgroundWithTransition("/asset/background.jpeg", true);
        }
      };
      restoreDefaultBackground();
    };
  }, []);

  useEffect(() => {
    if (restModalOpen && restShowCustomInput) {
      restCustomInputRef.current?.focus();
    }
  }, [restModalOpen, restShowCustomInput]);

  useEffect(() => {
    if (sceneTransitionResultStepIndex < 0) {
      return;
    }

    if (stepIndex < sceneTransitionResultStepIndex) {
      setSceneTransitionReplyReady(false);
      sceneTransitionAutoScrollPlayedRef.current = false;
      if (sceneTransitionReplyTimerRef.current !== null) {
        window.clearTimeout(sceneTransitionReplyTimerRef.current);
        sceneTransitionReplyTimerRef.current = null;
      }
    }
  }, [stepIndex, sceneTransitionResultStepIndex]);

  useEffect(() => {
    if (currentStep.focus !== "scene-transition-result") {
      sceneTransitionAutoScrollPlayedRef.current = false;
    }
  }, [currentStep.focus]);

  useEffect(() => {
    if (
      currentStep.focus !== "scene-transition-result" ||
      !sceneTransitionReplyReady
    ) {
      return;
    }
    if (sceneTransitionAutoScrollPlayedRef.current) {
      return;
    }

    const container = messagesScrollAreaRef.current;
    if (!container) {
      return;
    }
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    if (maxScrollTop <= 0) {
      sceneTransitionAutoScrollPlayedRef.current = true;
      return;
    }

    sceneTransitionAutoScrollPlayedRef.current = true;
    container.scrollTo({ top: 0, behavior: "auto" });

    const durationMs = 2000;
    const targetScrollTop = Math.max(0, maxScrollTop - 150);
    const easeInOut = (progress: number) =>
      progress < 0.5
        ? 2 * progress * progress
        : 1 - ((-2 * progress + 2) ** 2) / 2;
    let animationFrameId: number | null = null;
    let startTime: number | null = null;
    const animate = (timestamp: number) => {
      if (startTime === null) {
        startTime = timestamp;
      }
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      container.scrollTop = targetScrollTop * easeInOut(progress);

      if (progress < 1) {
        animationFrameId = window.requestAnimationFrame(animate);
      }
    };
    animationFrameId = window.requestAnimationFrame(animate);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [currentStep.focus, sceneTransitionReplyReady]);

  useEffect(() => {
    return () => {
      if (sceneTransitionReplyTimerRef.current !== null) {
        window.clearTimeout(sceneTransitionReplyTimerRef.current);
      }
    };
  }, []);

  const focusClass = (focus: TutorialFocus) =>
    currentStep.focus === focus ? " tutorial-focus" : "";

  const setFocusElement = useCallback(
    (focus: TutorialFocus, element: HTMLElement | null) => {
      focusRefs.current[focus] = element;
    },
    []
  );

  const updateBubblePosition = useCallback(() => {
    const target = focusRefs.current[currentStep.focus];
    const card = guideCardRef.current;
    const margin = 12;
    const gap = 14;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (!card || !target) {
      setBubblePosition({
        top: Math.max(margin, viewportHeight - 220),
        left: margin,
        placement: "top",
        arrowOffset: 40,
      });
      return;
    }

    const rect = target.getBoundingClientRect();
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const spaceTop = rect.top - margin;
    const spaceBottom = viewportHeight - rect.bottom - margin;
    const spaceLeft = rect.left - margin;
    const spaceRight = viewportWidth - rect.right - margin;

    let placement: BubblePlacement = "bottom";
    if (spaceBottom >= cardHeight + gap) {
      placement = "bottom";
    } else if (spaceTop >= cardHeight + gap) {
      placement = "top";
    } else if (spaceRight >= cardWidth + gap) {
      placement = "right";
    } else if (spaceLeft >= cardWidth + gap) {
      placement = "left";
    } else {
      const areas: Array<{ name: BubblePlacement; value: number }> = [
        { name: "bottom", value: spaceBottom },
        { name: "top", value: spaceTop },
        { name: "right", value: spaceRight },
        { name: "left", value: spaceLeft },
      ];
      areas.sort((a, b) => b.value - a.value);
      placement = areas[0]?.name ?? "bottom";
    }

    const clamp = (value: number, min: number, max: number) =>
      Math.min(Math.max(value, min), max);

    if (currentStep.focus === "scene-transition-result") {
      const top = clamp(
        rect.top + rect.height / 2 - cardHeight / 2,
        margin,
        viewportHeight - cardHeight - margin
      );
      const left = clamp(
        rect.right + gap,
        margin,
        viewportWidth - cardWidth - margin
      );
      const arrowOffset = clamp(
        rect.top + rect.height / 2 - top,
        18,
        cardHeight - 18
      );
      setBubblePosition({
        top,
        left,
        placement: "right",
        arrowOffset,
      });
      return;
    }

    if (
      currentStep.focus === "map" ||
      currentStep.focus === "map-updated"
    ) {
      const top = clamp(
        rect.top + rect.height / 2 - cardHeight / 2,
        margin,
        viewportHeight - cardHeight - margin
      );
      const left = clamp(
        rect.left - cardWidth - gap,
        margin,
        viewportWidth - cardWidth - margin
      );
      const arrowOffset = clamp(
        rect.top + rect.height / 2 - top,
        18,
        cardHeight - 18
      );
      setBubblePosition({
        top,
        left,
        placement: "left",
        arrowOffset,
      });
      return;
    }

    let top = margin;
    let left = margin;
    let arrowOffset = 40;

    if (placement === "bottom") {
      top = clamp(
        rect.bottom + gap,
        margin,
        viewportHeight - cardHeight - margin
      );
      left = clamp(
        rect.left + rect.width / 2 - cardWidth / 2,
        margin,
        viewportWidth - cardWidth - margin
      );
      arrowOffset = clamp(
        rect.left + rect.width / 2 - left,
        18,
        cardWidth - 18
      );
    } else if (placement === "top") {
      top = clamp(
        rect.top - cardHeight - gap,
        margin,
        viewportHeight - cardHeight - margin
      );
      left = clamp(
        rect.left + rect.width / 2 - cardWidth / 2,
        margin,
        viewportWidth - cardWidth - margin
      );
      arrowOffset = clamp(
        rect.left + rect.width / 2 - left,
        18,
        cardWidth - 18
      );
    } else if (placement === "right") {
      left = clamp(
        rect.right + gap,
        margin,
        viewportWidth - cardWidth - margin
      );
      top = clamp(
        rect.top + rect.height / 2 - cardHeight / 2,
        margin,
        viewportHeight - cardHeight - margin
      );
      arrowOffset = clamp(
        rect.top + rect.height / 2 - top,
        18,
        cardHeight - 18
      );
    } else {
      left = clamp(
        rect.left - cardWidth - gap,
        margin,
        viewportWidth - cardWidth - margin
      );
      top = clamp(
        rect.top + rect.height / 2 - cardHeight / 2,
        margin,
        viewportHeight - cardHeight - margin
      );
      arrowOffset = clamp(
        rect.top + rect.height / 2 - top,
        18,
        cardHeight - 18
      );
    }

    setBubblePosition({ top, left, placement, arrowOffset });
  }, [currentStep.focus]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      updateBubblePosition();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [sceneTransitionReplyReady, updateBubblePosition]);

  useEffect(() => {
    const run = () => updateBubblePosition();
    const frameId = window.requestAnimationFrame(run);

    window.addEventListener("resize", run);
    window.addEventListener("scroll", run, true);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", run);
      window.removeEventListener("scroll", run, true);
    };
  }, [updateBubblePosition]);

  return (
    <>
      <div className="game-container tutorial-mode">
        <div className="game-header backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg">
          <div style={{ width: "52px" }} aria-hidden="true" />
          <h1>{t("session.titleWithModule", { module: "Tutorial" })}</h1>
          <button
            type="button"
            onClick={handleExit}
            className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
            style={{ padding: "8px 12px" }}
            aria-label={t("tutorial.exit")}
          >
            ←
          </button>
        </div>

        <div className="game-main-layout">
          <div className="game-chat-container backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
            <div className="session-info-bar">
              <div className="character-info backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-3 py-1.5 h-9 flex items-center">
                <span className="character-label">
                  {t("session.playingAs")}
                </span>
                <span className="character-value">大熊</span>
              </div>
              <div className="save-checkpoint-section">
                <button
                  type="button"
                  className="save-checkpoint-btn backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl px-3 py-1.5 text-sm hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all h-9"
                >
                  <span className="save-btn-icon">💾</span>
                  <span className="save-btn-text">{t("session.save")}</span>
                </button>
              </div>
            </div>

            <div
              ref={messagesScrollAreaRef}
              className="messages-scroll-area"
              style={{ paddingBottom: "190px" }}
            >
              <div className="chat-message keeper">
                <div className="message-meta">
                  <span className="sender-name">🎭 {t("messages.keeper")}</span>
                </div>
                <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
                  {t("tutorial.mock.keeperMessage")}
                </div>
              </div>

              {showSceneTransitionMock && (
                <>
                  <div className="chat-message character">
                    <div className="message-meta">
                      <span className="sender-name">
                        📝 {t("sidebar.knowledge.you")}
                      </span>
                    </div>
                    <div className="message-text backdrop-blur-sm border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px] bg-[rgba(232,220,196,0.5)]">
                      {t("tutorial.mock.sceneTransitionInput")}
                    </div>
                  </div>

                  {sceneTransitionReplyReady ? (
                    <div
                      ref={(element) =>
                        setFocusElement("scene-transition-result", element)
                      }
                      className={`chat-message keeper${focusClass(
                        "scene-transition-result"
                      )}`}
                    >
                      <div className="message-meta">
                        <span className="sender-name">
                          🎭 {t("messages.keeper")}
                        </span>
                      </div>
                      <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
                        {t("tutorial.mock.sceneTransitionReply")}
                      </div>
                    </div>
                  ) : (
                    <div
                      ref={(element) =>
                        setFocusElement("scene-transition-result", element)
                      }
                      className={`chat-message keeper loading${focusClass(
                        "scene-transition-result"
                      )}`}
                    >
                      <div className="message-meta">
                        <span className="sender-name">
                          🎭 {t("messages.keeper")}
                        </span>
                      </div>
                      <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
                        ••• {t("messages.typing")}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none px-2 sm:px-0">
              <div
                ref={(element) => {
                  setFocusElement("message-intro", element);
                  setFocusElement("message-demo", element);
                  setFocusElement("scene-transition-input", element);
                }}
                className={`mx-auto w-full px-4 sm:px-0 pointer-events-auto rounded-3xl border border-white/30 dark:border-white/20 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)] ease-in-out ${
                  isInputCollapsedInTutorial
                    ? "max-w-[160px] max-h-6 overflow-hidden mb-3 [transition:max-height_0.5s_ease-in-out,max-width_1s_ease-in-out_0.5s]"
                    : "max-w-xl max-h-[80vh] mb-2 [transition:max-width_1s_ease-in-out,max-height_0.5s_ease-in-out]"
                }${isMessageFocused ? " tutorial-focus" : ""}
                `}
              >
                <div
                  className={`flex flex-col transition-opacity duration-300 ${
                    isInputCollapsedInTutorial
                      ? "space-y-0 opacity-0 pointer-events-none invisible"
                      : "space-y-1 opacity-100 visible"
                  }`}
                  aria-hidden={isInputCollapsedInTutorial}
                >
                  <div className="px-2 pb-2 pt-2">
                    <div className="relative">
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-slate-500/10 blur-3xl"
                      />
                      <form
                        className="relative z-10 overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] transition-all duration-300 ease-in-out bg-white/80 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl"
                        onSubmit={(e) => e.preventDefault()}
                      >
                        <div className="px-3 pt-2">
                          <div className="flex items-center">
                            <span className="text-[10px] uppercase tracking-wide text-slate-500">
                              {t("input.suggestedSkills")}
                            </span>
                          </div>
                          {showSuggestedSkills && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-200 px-2 py-0.5 text-[11px] text-amber-900 shadow-[0_10px_20px_rgba(124,45,18,0.25)] transition-all -translate-y-0.5"
                              >
                                侦查 65%
                              </button>
                              <button
                                type="button"
                                className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm transition-all border-slate-200 bg-white/70 text-slate-700"
                              >
                                心理学 45%
                              </button>
                            </div>
                          )}
                        </div>

                        <textarea
                          className="select-none md:text-sm max-h-12 px-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed w-full flex items-center h-16 min-h-10 resize-none rounded-md bg-transparent border-0 py-1 pl-2 pr-0.5 mt-2 shadow-none focus-visible:ring-0"
                          autoComplete="off"
                          name="message"
                          readOnly
                          value={typedInput}
                          placeholder={t("input.placeholder")}
                        />

                        <div className="flex items-center p-1.5 pt-0">
                          <button
                            ref={(element) =>
                              setFocusElement("rest-button", element)
                            }
                            type="button"
                            title={t("input.rest")}
                            onClick={openRestModal}
                            className={`inline-flex items-center justify-center whitespace-nowrap font-medium transition-all focus-visible:outline-none border shadow-sm hover:-translate-y-0.5 rounded-xl px-3 text-xs gap-1 h-[30px] mr-1.5 backdrop-blur-md bg-white/50 border-slate-200 text-slate-700 hover:bg-white/70 hover:border-slate-300${focusClass(
                              "rest-button"
                            )}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="size-3"
                              aria-hidden="true"
                            >
                              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                            </svg>
                            {t("input.rest")}
                          </button>
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-all focus-visible:outline-none backdrop-blur-md bg-white/50 border border-slate-200 text-slate-900 shadow-md hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 rounded-xl px-3 text-xs ml-auto gap-0.5 h-[30px]"
                          >
                            {t("input.send")}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {restModalOpen && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center"
                style={{
                  backdropFilter: "blur(4px)",
                  background: "rgba(15,23,42,0.45)",
                }}
                onMouseDown={closeRestModal}
              >
                <div
                  ref={(element) => setFocusElement("rest-panel", element)}
                  className={`relative w-[min(32rem,92vw)] rounded-2xl border border-white/40 bg-white/90 dark:bg-slate-900/90 shadow-[0_20px_50px_rgba(15,23,42,0.45)] backdrop-blur-xl px-7 py-6${
                    showRestPanelStep ? focusClass("rest-panel") : ""
                  }`}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {/* Header */}
                  <div className="mb-4 flex items-center gap-2.5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-slate-500"
                      aria-hidden="true"
                    >
                      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                    </svg>
                    <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
                      {t("input.restModal.title")}
                    </h2>
                  </div>

                  {/* Mechanics description */}
                  <div className="mb-4 rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-800/40">
                    <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
                      {t("input.restModal.mechanic")}
                    </p>
                    <ul className="space-y-1">
                      <li className="flex items-center gap-2 text-sm text-slate-400 dark:text-slate-500">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" />
                        {t("input.restModal.tier1")}
                      </li>
                      <li className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                        {t("input.restModal.tier2")}
                      </li>
                      <li className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                        {t("input.restModal.tier3")}
                      </li>
                    </ul>
                  </div>

                  {/* Choose label */}
                  <p className="mb-3 text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {t("input.restModal.chooseLabel")}
                  </p>

                  {/* Preset duration buttons */}
                  <div className="mb-4 grid grid-cols-4 gap-3">
                    {([1, 2, 4, 8] as const).map((h) => {
                      const tier = h < 4 ? "none" : h < 8 ? "fatigue" : "full";
                      const colorClass =
                        tier === "none"
                          ? "border-slate-200 bg-white/70 text-slate-400 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-500"
                          : tier === "fatigue"
                            ? "border-amber-200 bg-amber-50/80 text-amber-800 hover:border-amber-300 hover:bg-amber-100 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300"
                            : "border-emerald-200 bg-emerald-50/80 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-700/60 dark:bg-emerald-900/20 dark:text-emerald-300";
                      return (
                        <button
                          key={h}
                          type="button"
                          className={`rounded-xl border px-0 py-3 text-base font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${colorClass} ${
                            restSelectedHours === h && !restShowCustomInput
                              ? "ring-2 ring-amber-300 dark:ring-amber-500"
                              : ""
                          }`}
                          onClick={() => {
                            setRestSelectedHours(h);
                            setRestShowCustomInput(false);
                            setRestCustomHours("");
                          }}
                        >
                          {h}h
                        </button>
                      );
                    })}
                  </div>

                  {/* Custom hours */}
                  {restShowCustomInput ? (
                    <div className="mb-4">
                      <input
                        ref={restCustomInputRef}
                        type="number"
                        min="1"
                        max="24"
                        value={restCustomHours}
                        onChange={(e) => {
                          setRestCustomHours(e.target.value);
                          setRestSelectedHours(null);
                        }}
                        placeholder={t("input.restModal.customPlaceholder")}
                        className="flex-1 rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-base text-slate-800 shadow-sm focus:border-amber-300 focus:outline-none dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mb-4 w-full rounded-xl border border-slate-200 bg-white/60 py-3 text-sm text-slate-500 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white/80 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-400"
                      onClick={() => {
                        setRestShowCustomInput(true);
                        setRestSelectedHours(null);
                      }}
                    >
                      {t("input.restModal.customHours")}
                    </button>
                  )}

                  <button
                    type="button"
                    className="mb-3 w-full rounded-xl border border-amber-300 bg-amber-100 py-3 text-sm font-medium text-amber-900 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-40 disabled:pointer-events-none"
                    onClick={handleRestConfirm}
                    disabled={isRestConfirmDisabled}
                  >
                    {t("input.restModal.confirm")}
                  </button>

                  {/* Cancel */}
                  <button
                    type="button"
                    className="w-full rounded-xl border border-slate-200 bg-transparent py-3 text-sm text-slate-400 transition-all hover:bg-slate-100/60 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-800/40"
                    onClick={closeRestModal}
                  >
                    {t("input.restModal.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="game-sidebar backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
            <div className="sidebar-tabs">
              <button
                type="button"
                className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${
                  activeSidebarTab === "status" ? "active" : ""
                }`}
              >
                {t("sidebar.tabs.status")}
              </button>
              <button
                type="button"
                className="sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all"
              >
                {t("sidebar.tabs.notes")}
              </button>
              <button
                type="button"
                className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${
                  activeSidebarTab === "knowledge" ? "active" : ""
                }`}
              >
                {t("sidebar.tabs.knowledge")}
              </button>
              <button
                type="button"
                className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${
                  activeSidebarTab === "map" ? "active" : ""
                }`}
              >
                {t("sidebar.tabs.map")}
              </button>
            </div>

            <div className="sidebar-content">
              {activeSidebarTab === "status" && (
                <div className="tab-panel status-panel">
                  <div
                    ref={(element) =>
                      setFocusElement("sidebar-status", element)
                    }
                    className={`status-section${focusClass("sidebar-status")}`}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "12px",
                      }}
                    >
                      <h3 style={{ margin: 0 }}>
                        {t("sidebar.status.basicAttributes")}
                      </h3>
                      <button
                        type="button"
                        className="view-character-btn-sidebar"
                      >
                        {t("sidebar.status.viewCharacter")}
                      </button>
                    </div>
                    <div className="status-grid">
                      <div className="status-item">
                        <span className="status-label">
                          {t("sidebar.status.hp")}
                        </span>
                        <span className="status-value">11/12</span>
                      </div>
                      <div className="status-item">
                        <span className="status-label">
                          {t("sidebar.status.mp")}
                        </span>
                        <span className="status-value">8/8</span>
                      </div>
                      <div className="status-item">
                        <span className="status-label">
                          {t("sidebar.status.san")}
                        </span>
                        <span className="status-value">54/60</span>
                      </div>
                      <div className="status-item">
                        <span className="status-label">
                          {t("sidebar.status.luck")}
                        </span>
                        <span className="status-value">48</span>
                      </div>
                    </div>
                  </div>

                  <div className="status-section">
                    <h3>{t("sidebar.status.currentStatus")}</h3>
                    <div className="status-list">
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("sidebar.status.location")}
                        </span>
                        <span className="status-value">
                          {tutorialStatusLocation}
                        </span>
                      </div>
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("sidebar.status.time")}
                        </span>
                        <span className="status-value">{tutorialStatusTime}</span>
                      </div>
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("sidebar.status.day")}
                        </span>
                        <span className="status-value">
                          {t("sidebar.dayNumber", { day: 1 })}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="status-section">
                    <h3>{t("sidebar.status.statusEffects")}</h3>
                    <div
                      ref={(element) => setFocusElement("fatigue", element)}
                      className={`status-effects${focusClass("fatigue")}`}
                    >
                      {showFatigue ? (
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            background: "#fef3c7",
                            border: "1px solid #f59e0b",
                            borderRadius: "9999px",
                            padding: "2px 10px",
                            fontSize: "12px",
                            color: "#92400e",
                            marginBottom: "4px",
                          }}
                          title={t("sidebar.status.fatiguedDesc")}
                        >
                          😴 {t("sidebar.status.fatigued")}
                        </div>
                      ) : (
                        <p className="empty-state">
                          {t("sidebar.status.noStatusEffects")}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeSidebarTab === "knowledge" && (
                <div
                  ref={(element) => setFocusElement("knowledge", element)}
                  className={`tab-panel${focusClass("knowledge")}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                    padding: 0,
                    overflow: "hidden",
                  }}
                >
                  <div
                    className="messages-scroll-area"
                    style={{ flex: 1, paddingBottom: "12px" }}
                  >
                    <div className="chat-message character">
                      <div className="message-meta">
                        <span className="sender-name">
                          📝 {t("sidebar.knowledge.you")}
                        </span>
                      </div>
                      <div className="message-text backdrop-blur-sm border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px] bg-[rgba(232,220,196,0.5)]">
                        {t("tutorial.mock.knowledgeQ")}
                      </div>
                    </div>

                    <div className="chat-message keeper">
                      <div className="message-meta">
                        <span className="sender-name">
                          🔍 {t("sidebar.knowledge.assistant")}
                        </span>
                      </div>
                      <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
                        {t("tutorial.mock.knowledgeA")}
                      </div>
                    </div>
                  </div>

                  <div className="px-2 pb-2 pt-1">
                    <div className="rounded-3xl border border-white/30 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)] px-2 pb-2 pt-2">
                      <form
                        onSubmit={(e) => e.preventDefault()}
                        className="relative overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] bg-white/80 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl"
                      >
                        <textarea
                          className="select-none text-sm placeholder:text-muted-foreground focus-visible:outline-none w-full min-h-[64px] resize-none rounded-md bg-transparent border-0 py-2 px-3 shadow-none focus-visible:ring-0"
                          readOnly
                          placeholder={t("sidebar.knowledge.queryPlaceholder")}
                        />
                        <div className="flex items-center p-1.5 pt-0">
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-all focus-visible:outline-none backdrop-blur-md bg-white/50 border border-slate-200 text-slate-900 shadow-md hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 rounded-xl px-3 text-xs ml-auto gap-0.5 h-[30px]"
                          >
                            {t("sidebar.knowledge.ask")}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </div>
              )}

              {activeSidebarTab === "map" && (
                <div className="tab-panel map-panel">
                  {(() => {
                    const isMapUpdatedStep = currentStep.focus === "map-updated";
                    return (
                      <div
                        ref={(element) => {
                          setFocusElement("map", element);
                          setFocusElement("map-updated", element);
                        }}
                        className={`status-section${focusClass("map")}${focusClass(
                          "map-updated"
                        )}`}
                      >
                        <h3>{t("sidebar.map.macroMap")}</h3>
                        <div className="tutorial-map-image-wrap">
                          <img
                            src={
                              isMapUpdatedStep
                                ? "/tutorial/map-2.png"
                                : "/tutorial/map-1.png"
                            }
                            alt={t("sidebar.map.macroMap")}
                            className="tutorial-map-image"
                          />
                        </div>
                      </div>
                    );
                  })()}

                  <div className="status-section">
                    <h3>{t("sidebar.map.currentScene")}</h3>
                    <div className="status-list">
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("sidebar.map.sceneName")}
                        </span>
                        <span className="status-value">
                          {tutorialMapSceneName}
                        </span>
                      </div>
                      <div className="status-item-full">
                        <span className="status-label">
                          {t("sidebar.status.location")}
                        </span>
                        <span className="status-value">{tutorialMapLocation}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="tutorial-guide-overlay" aria-hidden="true" />
      <div
        ref={guideCardRef}
        className="tutorial-guide-card backdrop-blur-md bg-white/80 border border-slate-200 shadow-xl rounded-2xl"
        style={{
          top: `${bubblePosition.top}px`,
          left: `${bubblePosition.left}px`,
        }}
      >
        <span
          className={`tutorial-guide-arrow ${bubblePosition.placement}`}
          style={
            bubblePosition.placement === "top" ||
            bubblePosition.placement === "bottom"
              ? { left: `${bubblePosition.arrowOffset}px` }
              : { top: `${bubblePosition.arrowOffset}px` }
          }
          aria-hidden="true"
        />
        <div className="tutorial-guide-meta">
          {t("tutorial.stepCounter", {
            current: stepIndex + 1,
            total: steps.length,
          })}
        </div>
        <h2>{currentStep.title}</h2>
        <p>{currentStep.description}</p>
        <div className="tutorial-guide-actions">
          <button
            type="button"
            className="plain"
            onClick={handlePrevious}
            disabled={stepIndex === 0}
          >
            {t("tutorial.previous")}
          </button>
          <button type="button" className="plain" onClick={handleExit}>
            {t("tutorial.skip")}
          </button>
          <button type="button" className="solid" onClick={handleNext}>
            {isLastStep ? t("tutorial.finish") : t("tutorial.next")}
          </button>
        </div>
      </div>

      <style>{`
        .tutorial-mode {
          padding-bottom: 24px;
        }

        .tutorial-mode button {
          pointer-events: none !important;
          cursor: default !important;
        }

        .tutorial-guide-overlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.34);
          z-index: 2000;
          pointer-events: none;
        }

        .tutorial-guide-card {
          position: fixed;
          width: min(420px, calc(100vw - 24px));
          z-index: 2300;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: top 0.2s ease, left 0.2s ease;
        }

        .tutorial-guide-arrow {
          position: absolute;
          width: 0;
          height: 0;
          transform: translate(-50%, -50%);
        }

        .tutorial-guide-arrow.bottom {
          top: -1px;
          border-left: 10px solid transparent;
          border-right: 10px solid transparent;
          border-bottom: 10px solid rgba(255, 255, 255, 0.9);
        }

        .tutorial-guide-arrow.top {
          bottom: -10px;
          transform: translateX(-50%);
          border-left: 10px solid transparent;
          border-right: 10px solid transparent;
          border-top: 10px solid rgba(255, 255, 255, 0.9);
        }

        .tutorial-guide-arrow.left {
          right: -10px;
          transform: translateY(-50%);
          border-top: 10px solid transparent;
          border-bottom: 10px solid transparent;
          border-left: 10px solid rgba(255, 255, 255, 0.9);
        }

        .tutorial-guide-arrow.right {
          left: -1px;
          transform: translate(-100%, -50%);
          border-top: 10px solid transparent;
          border-bottom: 10px solid transparent;
          border-right: 10px solid rgba(255, 255, 255, 0.9);
        }

        .tutorial-guide-card h2 {
          margin: 0;
          color: var(--title);
          font-size: 1.05rem;
        }

        .tutorial-guide-card p {
          margin: 0;
          line-height: 1.5;
          color: #334155;
          font-size: 0.92rem;
        }

        .tutorial-guide-meta {
          font-size: 0.78rem;
          color: #64748b;
          font-family: var(--mono);
        }

        .tutorial-guide-actions {
          margin-top: 4px;
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .tutorial-guide-actions button {
          border-radius: 10px;
          padding: 7px 12px;
          border: 1px solid rgba(203, 213, 225, 0.9);
          cursor: pointer;
          font-family: var(--serif);
        }

        .tutorial-guide-actions button.plain {
          background: rgba(255, 255, 255, 0.85);
          color: #334155;
        }

        .tutorial-guide-actions button.plain:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }

        .tutorial-guide-actions button.solid {
          background: #6b5a45;
          border-color: #6b5a45;
          color: #fff;
          font-weight: 700;
        }

        .tutorial-map-image-wrap {
          border: 1px solid rgba(203, 213, 225, 0.8);
          border-radius: 10px;
          overflow: hidden;
          background: rgba(248, 250, 252, 0.78);
          box-shadow: 0 6px 16px rgba(15, 23, 42, 0.18);
        }

        .tutorial-map-image {
          width: 100%;
          display: block;
          object-fit: cover;
          transition: opacity 0.35s ease-in-out;
        }

        .tutorial-focus {
          position: relative;
          z-index: 2201;
          box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.95), 0 0 0 7px rgba(251, 191, 36, 0.3), 0 6px 18px rgba(15, 23, 42, 0.35);
        }

        @media (max-width: 1024px) {
          .tutorial-guide-card {
            width: min(360px, calc(100vw - 20px));
          }
        }
      `}</style>
    </>
  );
};
