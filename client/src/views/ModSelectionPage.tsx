import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ModSelector } from "../components/ModSelector";
import { ModLoadingModal } from "../components/modals/ModLoadingModal";
import { useGameSession } from "../hooks/useGameSession";
import { authFetch } from "../utils/authFetch";

export const ModSelectionPage: React.FC = () => {
  const { t } = useTranslation(["module", "common"]);
  const navigate = useNavigate();
  const gameSession = useGameSession();

  const [loadingModData, setLoadingModData] = useState(false);
  const [modLoadProgress, setModLoadProgress] = useState<{
    stage: string;
    progress: number;
    message: string;
  } | null>(null);

  // Handle mod selection - load mod data, then fetch and show module introduction
  const handleSelectMod = async (modName: string) => {
    gameSession.setSelectedModName(modName);
    setLoadingModData(true);
    setModLoadProgress({
      stage: t("module:moduleLoad.stages.initializing"),
      progress: 0,
      message: t("module:moduleLoad.messages.initializing"),
    });

    try {
      // Step 1: Load module data via SSE with authFetch (supports authentication)
      let loadData: any = null;

      const loadResponse = await authFetch("/api/mod/load?stream=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ modName }),
      });

      if (!loadResponse.ok) {
        // Try to read error message from stream or JSON
        const reader = loadResponse.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let errorBuffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            errorBuffer += decoder.decode(value, { stream: true });
          }
          try {
            const errorData = JSON.parse(errorBuffer);
            throw new Error(
              errorData.error || t("module:errors.loadFailed")
            );
          } catch (e) {
            throw new Error(errorBuffer || t("module:errors.loadFailed"));
          }
        } else {
          throw new Error(t("module:errors.loadFailed"));
        }
      }

      // Read SSE stream
      const reader = loadResponse.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));

                // Check for errors
                if (data.stage === "Error" && data.message) {
                  throw new Error(data.message);
                }

                // Update progress if this is a progress update
                if (
                  data.stage &&
                  typeof data.progress === "number" &&
                  data.message
                ) {
                  setModLoadProgress({
                    stage: data.stage,
                    progress: data.progress,
                    message: data.message,
                  });
                }

                // Store final result data
                if (data.success && data.scenariosLoaded !== undefined) {
                  loadData = data;
                }
              } catch (e) {
                // If it's an Error object we threw, re-throw it
                if (e instanceof Error && e.message) {
                  throw e;
                }
                console.error("Error parsing SSE data:", e, line);
              }
            }
          }
        }
      }

      if (!loadData) {
        throw new Error(t("module:moduleLoad.errors.noLoadResult"));
      }

      // Step 2: Fetch module introduction
      setModLoadProgress({
        stage: t("module:moduleLoad.stages.generatingIntro"),
        progress: 90,
        message: t("module:moduleLoad.messages.generatingIntro"),
      });
      const introResponse = await authFetch(
        `/api/module/introduction?modName=${encodeURIComponent(modName)}`
      );
      const introData = await introResponse.json();

      if (introResponse.ok && introData.success) {
        gameSession.setModuleIntroduction(introData.moduleIntroduction);
        setModLoadProgress({
          stage: t("module:moduleLoad.stages.complete"),
          progress: 100,
          message: t("module:moduleLoad.messages.ready"),
        });
        setTimeout(() => {
          setLoadingModData(false);
          setModLoadProgress(null);
          navigate("/mod/intro");
        }, 500);
      } else {
        // If failed to get introduction, go directly to character select
        console.error("Failed to get module introduction:", introData.error);
        setLoadingModData(false);
        setModLoadProgress(null);
        navigate("/character/select");
      }
    } catch (error) {
      console.error("Error loading mod:", error);
      setLoadingModData(false);
      setModLoadProgress(null);
      alert(`${t("module:errors.loadFailed")}: ${(error as Error).message}`);
    }
  };

  return (
    <>
      <ModSelector
        onSelectMod={handleSelectMod}
        onCancel={() => navigate("/")}
        onCreateStory={() => navigate("/story/create")}
      />

      <ModLoadingModal
        loading={loadingModData}
        progress={modLoadProgress}
      />
    </>
  );
};
