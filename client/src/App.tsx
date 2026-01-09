import React, { useMemo, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Login from "./views/auth/Login";
import Register from "./views/auth/Register";
import Homes from "./views/Homes";
import { GameChat } from "./components/GameChat";
import { GameSidebar } from "./components/GameSidebar";
import { CharacterSelector } from "./components/CharacterSelector";
import { ModSelector } from "./components/ModSelector";

type SkillEntry = { name: string; base: string; category: string };
type AppPage = "home" | "sheet" | "game" | "character-select" | "mod-select" | "module-intro";

const SKILLS: SkillEntry[] = [
  // Interpersonal & Social Skills
  { name: "Charm", base: "15%", category: "Social" },
  { name: "Fast Talk", base: "5%", category: "Social" },
  { name: "Intimidate", base: "15%", category: "Social" },
  { name: "Persuade", base: "10%", category: "Social" },
  { name: "Psychology", base: "10%", category: "Social" },

  // Knowledge & Academic Skills
  { name: "Accounting", base: "5%", category: "Knowledge" },
  { name: "Anthropology", base: "1%", category: "Knowledge" },
  { name: "Archaeology", base: "1%", category: "Knowledge" },
  { name: "Art and Craft", base: "5%", category: "Knowledge" },
  { name: "History", base: "5%", category: "Knowledge" },
  { name: "Law", base: "5%", category: "Knowledge" },
  { name: "Library Use", base: "20%", category: "Knowledge" },
  { name: "Occult", base: "5%", category: "Knowledge" },
  { name: "Science (Biology)", base: "1%", category: "Knowledge" },
  { name: "Science (Chemistry)", base: "1%", category: "Knowledge" },
  { name: "Science (Physics)", base: "1%", category: "Knowledge" },

  // Perception & Investigation Skills
  { name: "Listen", base: "20%", category: "Investigation" },
  { name: "Spot Hidden", base: "25%", category: "Investigation" },
  { name: "Track", base: "10%", category: "Investigation" },

  // Physical & Movement Skills
  { name: "Climb", base: "20%", category: "Physical" },
  { name: "Dodge", base: "0%", category: "Physical" },
  { name: "Jump", base: "20%", category: "Physical" },
  { name: "Swim", base: "20%", category: "Physical" },
  { name: "Throw", base: "20%", category: "Physical" },

  // Stealth & Deception Skills
  { name: "Disguise", base: "5%", category: "Stealth" },
  { name: "Sleight of Hand", base: "10%", category: "Stealth" },
  { name: "Stealth", base: "20%", category: "Stealth" },

  // Mechanical & Technical Skills
  { name: "Electrical Repair", base: "10%", category: "Technical" },
  { name: "Mechanical Repair", base: "10%", category: "Technical" },
  { name: "Operate Heavy Machinery", base: "1%", category: "Technical" },
  { name: "Pilot (Aircraft)", base: "1%", category: "Technical" },
  { name: "Pilot (Boat)", base: "1%", category: "Technical" },
  { name: "Drive Auto", base: "20%", category: "Technical" },

  // Medical & Survival Skills
  { name: "First Aid", base: "30%", category: "Medical" },
  { name: "Medicine", base: "1%", category: "Medical" },
  { name: "Natural World", base: "10%", category: "Medical" },
  { name: "Survival (Arctic)", base: "10%", category: "Medical" },
  { name: "Survival (Desert)", base: "10%", category: "Medical" },
  { name: "Survival (Forest)", base: "10%", category: "Medical" },

  // Combat Skills - Fighting
  { name: "Fighting (Brawl)", base: "25%", category: "Combat" },
  { name: "Fighting (Sword)", base: "20%", category: "Combat" },
  { name: "Fighting (Axe)", base: "15%", category: "Combat" },
  { name: "Fighting (Whip)", base: "5%", category: "Combat" },

  // Combat Skills - Firearms
  { name: "Firearms (Handgun)", base: "20%", category: "Combat" },
  { name: "Firearms (Rifle/Shotgun)", base: "25%", category: "Combat" },
  { name: "Firearms (Submachine Gun)", base: "15%", category: "Combat" },
  { name: "Firearms (Bow)", base: "15%", category: "Combat" },

  // Criminal & Subterfuge Skills
  { name: "Locksmith", base: "1%", category: "Criminal" },
  { name: "Criminology", base: "1%", category: "Criminal" },
  { name: "Forgery", base: "1%", category: "Criminal" },

  // Communication & Language Skills
  { name: "Language (Own)", base: "0%", category: "Language" },
  { name: "Language (Other)", base: "1%", category: "Language" },

  // Financial & Status Skill
  { name: "Credit Rating", base: "0%", category: "Status" },

  // Cthulhu Mythos
  { name: "Cthulhu Mythos", base: "0%", category: "Mythos" },

  // Additional Common Skills
  { name: "Appraise", base: "5%", category: "Knowledge" },
  { name: "Navigate", base: "10%", category: "Technical" },
  { name: "Psychoanalysis", base: "1%", category: "Medical" },
  { name: "Ride", base: "5%", category: "Physical" },
];

const AppShell: React.FC = () => {
  const [page, setPage] = useState<AppPage>("home");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [occupations, setOccupations] = useState<any[]>([]);
  const [selectedOccupation, setSelectedOccupation] = useState<any>(null);
  const [occupationalPoints, setOccupationalPoints] = useState<number>(0);
  const [weaponsList, setWeaponsList] = useState<any[]>([]);
  const [interestPoints, setInterestPoints] = useState<number>(0);
  const [sessionId, setSessionId] = useState<string>("");
  const [showAttributeSelector, setShowAttributeSelector] = useState(false);
  const [attributeOptions, setAttributeOptions] = useState<any[]>([]);
  const [characterName, setCharacterName] = useState<string>("Investigator");
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>("");
  const [selectedModName, setSelectedModName] = useState<string>("");
  const [showCheckpointSelector, setShowCheckpointSelector] = useState(false);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);
  const [moduleIntroduction, setModuleIntroduction] = useState<{ introduction: string; moduleNotes: string } | null>(null);
  const [showModuleIntro, setShowModuleIntro] = useState(false);
  const [loadingModData, setLoadingModData] = useState(false);
  const [modLoadProgress, setModLoadProgress] = useState<{ stage: string; progress: number; message: string } | null>(null);
  const [conversationHistory, setConversationHistory] = useState<Array<{
    role: 'character' | 'keeper';
    content: string;
    timestamp: string;
    turnNumber: number;
    diceRolls?: string[];
  }> | null>(null);
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);
  const [isCreatingFromGameFlow, setIsCreatingFromGameFlow] = useState(false);

  const [form, setForm] = React.useState<Record<string, string>>({});
  const { user, logout } = useAuth();
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error("Error logging out:", error);
    } finally {
      setIsUserMenuOpen(false);
    }
  };

  const userMenu = user ? (
    <div
      style={{
        position: "fixed",
        top: "16px",
        right: "16px",
        zIndex: 5000,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "8px",
      }}
    >
      <button
        onClick={() => setIsUserMenuOpen((prev) => !prev)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          borderRadius: "999px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          background: "rgba(0, 0, 0, 0.65)",
          color: "#f5f1e8",
          fontSize: "0.9rem",
          cursor: "pointer",
          boxShadow: "0 6px 18px rgba(0, 0, 0, 0.25)",
          maxWidth: "240px",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.email}
        </span>
        <span style={{ fontSize: "0.75rem", opacity: 0.8 }}>{isUserMenuOpen ? "▲" : "▼"}</span>
      </button>
      {isUserMenuOpen && (
        <div
          style={{
            width: "200px",
            background: "#fffaf2",
            borderRadius: "10px",
            border: "1px solid rgba(0, 0, 0, 0.1)",
            boxShadow: "0 12px 24px rgba(0, 0, 0, 0.2)",
            padding: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div
            style={{
              fontSize: "0.85rem",
              color: "#5a4a3a",
              borderBottom: "1px solid rgba(0, 0, 0, 0.08)",
              paddingBottom: "8px",
              wordBreak: "break-all",
            }}
          >
            {user.email}
          </div>
          <button
            onClick={handleLogout}
            style={{
              padding: "8px 10px",
              borderRadius: "6px",
              border: "none",
              background: "#8b7355",
              color: "#f5f1e8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  ) : null;

  // Fetch weapons on component mount
  React.useEffect(() => {
    const fetchWeapons = async () => {
      try {
        const response = await fetch("/api/weapons");
        const data = await response.json();

        if (data.success && data.weapons) {
          setWeaponsList(data.weapons);
        }
      } catch (error) {
        console.error("Error fetching weapons:", error);
      }
    };

    fetchWeapons();
  }, []);

  // Fetch occupations on component mount
  React.useEffect(() => {
    const fetchOccupations = async () => {
      try {
        const response = await fetch("/api/occupations");
        const data = await response.json();

        if (data.success && data.occupations) {
          // Flatten all occupations from all groups
          const allOccupations: any[] = [];
          data.occupations.groups.forEach((group: any) => {
            group.occupations.forEach((occ: any) => {
              allOccupations.push({
                ...occ,
                groupName: group.name_zh,
              });
            });
          });
          setOccupations(allOccupations);
        }
      } catch (error) {
        console.error("Error fetching occupations:", error);
      }
    };

    fetchOccupations();
  }, []);

  // Calculate occupational and interest skill points
  React.useEffect(() => {
    // Calculate interest points (INT × 2)
    const intValue = Number(form.INT) || 0;
    setInterestPoints(intValue * 2);

    // Calculate occupational points based on selected occupation
    if (selectedOccupation && selectedOccupation.suggested_occupational_points) {
      const expression = selectedOccupation.suggested_occupational_points.expression;

      try {
        // Parse and evaluate the expression
        // Replace attribute names with their values from form
        let evaluatedExpression = expression
          .replace(/STR/g, String(Number(form.STR) || 0))
          .replace(/CON/g, String(Number(form.CON) || 0))
          .replace(/DEX/g, String(Number(form.DEX) || 0))
          .replace(/APP/g, String(Number(form.APP) || 0))
          .replace(/POW/g, String(Number(form.POW) || 0))
          .replace(/SIZ/g, String(Number(form.SIZ) || 0))
          .replace(/INT/g, String(Number(form.INT) || 0))
          .replace(/EDU/g, String(Number(form.EDU) || 0));

        // Safely evaluate the expression
        // eslint-disable-next-line no-eval
        const result = eval(evaluatedExpression);
        setOccupationalPoints(Math.floor(result));
      } catch (error) {
        console.error("Error calculating occupational points:", error);
        setOccupationalPoints(0);
      }
    } else {
      setOccupationalPoints(0);
    }
  }, [form.STR, form.CON, form.DEX, form.APP, form.POW, form.SIZ, form.INT, form.EDU, selectedOccupation]);

  // Show mod selector first, then character selector
  const handleShowCharacterSelector = () => {
    setPage("mod-select");
  };

  // Handle mod selection - load mod data, then fetch and show module introduction
  const handleSelectMod = async (modName: string) => {
    setSelectedModName(modName);
    setLoadingModData(true);
    setModLoadProgress({ stage: "Initializing", progress: 0, message: "Initializing..." });
    
    try {
      // Step 1: Load mod data with SSE progress updates
      let loadData: any = null;
      
      const loadResponse = await fetch("/api/mod/load?stream=true", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
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
            throw new Error(errorData.error || "Failed to load module data");
          } catch (e) {
            throw new Error(errorBuffer || "Failed to load module data");
          }
        } else {
          throw new Error("Failed to load module data");
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
                if (data.stage && typeof data.progress === "number" && data.message) {
                  setModLoadProgress({ 
                    stage: data.stage, 
                    progress: data.progress, 
                    message: data.message 
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
        throw new Error("Server did not return load result");
      }

      // Step 2: Fetch module introduction
      setModLoadProgress({ stage: "Generating Introduction Narrative", progress: 90, message: "Generating module introduction narrative..." });
      const introResponse = await fetch(`/api/module/introduction?modName=${encodeURIComponent(modName)}`);
      const introData = await introResponse.json();

      if (introResponse.ok && introData.success) {
        setModuleIntroduction(introData.moduleIntroduction);
        setModLoadProgress({ stage: "Complete", progress: 100, message: "Ready" });
        setTimeout(() => {
          setLoadingModData(false);
          setModLoadProgress(null);
          setPage("module-intro"); // Show module introduction page
        }, 500);
      } else {
        // If failed to get introduction, go directly to character select
        console.error("Failed to get module introduction:", introData.error);
        setLoadingModData(false);
        setModLoadProgress(null);
        setPage("character-select");
      }
    } catch (error) {
      console.error("Error loading mod:", error);
      setLoadingModData(false);
      setModLoadProgress(null);
      alert("Failed to load module: " + (error as Error).message);
      setPage("mod-select");
    }
  };

  // Handle character selection and start game
  // Note: Data import is now handled in CharacterSelector component
  const handleSelectCharacter = async (characterId: string, charName: string) => {
    console.log("Selected character:", characterId, charName);
    setSelectedCharacterId(characterId);
    setCharacterName(charName);
    
    try {
      // Start game with selected character and mod
      const response = await fetch("/api/game/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId, modName: selectedModName }),
      });

      const data = await response.json();

      if (response.ok) {
        setSessionId(data.sessionId || `session-${Date.now()}`);
        // Clear conversation history for new game (will be loaded from API)
        setConversationHistory(null);
        // Don't show module introduction again (already shown before character selection)
        setShowModuleIntro(false);
        setPage("game");
      } else {
        alert("Failed to start game: " + (data.error || "Unknown error"));
        setPage("character-select");
      }
    } catch (error) {
      console.error("Error starting game:", error);
      alert("Network error, unable to connect to server");
      setPage("character-select");
    }
  };

  const handleBackToHome = () => {
    setPage("home");
  };

  // Handle continue game - show checkpoint selector
  const handleContinueGame = async () => {
    setShowCheckpointSelector(true);
    setLoadingCheckpoints(true);

    try {
      // Get all checkpoints (we'll filter by session later if needed)
      // For now, we'll get checkpoints from a default session or all sessions
      const response = await fetch(`/api/checkpoints/list?sessionId=all&limit=50`);
      const data = await response.json();

      if (data.success) {
        setCheckpoints(data.checkpoints || []);
      } else {
        alert("Failed to load checkpoint list: " + (data.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error loading checkpoints:", error);
      alert("Network error, unable to load checkpoint list");
    } finally {
      setLoadingCheckpoints(false);
    }
  };

  // Handle checkpoint selection and load
  const handleLoadCheckpoint = async (checkpointId: string) => {
    try {
      const response = await fetch("/api/checkpoints/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Restore game state
        setSessionId(data.sessionId || `session-${Date.now()}`);
        
        // Extract character name from game state if available
        if (data.gameState?.playerCharacter?.name) {
          setCharacterName(data.gameState.playerCharacter.name);
        }

        // Load conversation history if provided
        if (data.conversationHistory && Array.isArray(data.conversationHistory)) {
          setConversationHistory(data.conversationHistory);
          console.log(`Loaded ${data.conversationHistory.length} messages from checkpoint`);
        } else {
          setConversationHistory(null);
        }

        // Don't show module introduction when loading checkpoint (only for new games)
        setShowModuleIntro(false);
        setModuleIntroduction(null);

        // Close checkpoint selector and go to game
        setShowCheckpointSelector(false);
        setPage("game");
      } else {
        alert("Failed to load checkpoint: " + (data.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error loading checkpoint:", error);
      alert("Network error, unable to load checkpoint");
    }
  };

  const onChange = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Handle random attribute generation - generate one set and show modal
  const handleRandomizeAttributes = async () => {
    try {
      const age = Number(form.age) || undefined;
      const response = await fetch("/api/character/random-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ age }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setAttributeOptions([{ id: 1, attributes: data.attributes }]);
        setShowAttributeSelector(true);
      } else {
        alert("Failed to generate attributes: " + (data.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error generating random attributes:", error);
      alert("Network error, unable to generate random attributes");
    }
  };

  // Generate another attribute set in the modal (max 5 sets)
  const handleGenerateAnotherSet = async () => {
    if (attributeOptions.length >= 5) {
      return;
    }

    try {
      const age = Number(form.age) || undefined;
      const response = await fetch("/api/character/random-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ age }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setAttributeOptions((prev) => [
          ...prev,
          { id: prev.length + 1, attributes: data.attributes }
        ]);
      } else {
        alert("Failed to generate attributes: " + (data.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error generating random attributes:", error);
      alert("Network error, unable to generate random attributes");
    }
  };

  // Handle attribute set selection
  const handleSelectAttributeSet = (attributes: any) => {
    setForm((prev) => ({
      ...prev,
      ...attributes,
    }));
    setShowAttributeSelector(false);
    setAttributeOptions([]);
  };

  const skillsState = useMemo(() => {
    return SKILLS.map((skill) => ({
      name: skill.name,
      base: skill.base,
      category: skill.category,
      occupationalValue: form[`skill_occ_${skill.name}`] || "",
      interestValue: form[`skill_int_${skill.name}`] || "",
    }));
  }, [form]);

  // Calculate used skill points
  const skillPointsUsage = useMemo(() => {
    let occupationalUsed = 0;
    let interestUsed = 0;

    skillsState.forEach((skill) => {
      const occupationalValue = parseInt(skill.occupationalValue) || 0;
      const interestValue = parseInt(skill.interestValue) || 0;

      occupationalUsed += occupationalValue;
      interestUsed += interestValue;
    });

    return {
      occupationalUsed,
      interestUsed,
      occupationalRemaining: Math.max(0, occupationalPoints - occupationalUsed),
      interestRemaining: Math.max(0, interestPoints - interestUsed),
    };
  }, [skillsState, occupationalPoints, interestPoints]);

  const weapons = [0, 1, 2].map((i) => ({
    name: form[`weapon_${i}_name`] || "",
    skill: form[`weapon_${i}_skill`] || "",
    damage: form[`weapon_${i}_damage`] || "",
    range: form[`weapon_${i}_range`] || "",
    attacks: form[`weapon_${i}_attacks`] || "",
    ammo: form[`weapon_${i}_ammo`] || "",
  }));

  // Items/Inventory following backend InventoryItem interface
  const items = [0, 1, 2, 3, 4].map((i) => ({
    name: form[`item_${i}_name`] || "",
    quantity: form[`item_${i}_quantity`] ? Number(form[`item_${i}_quantity`]) : undefined,
    properties: form[`item_${i}_description`] ? { description: form[`item_${i}_description`] } : undefined,
  }));

  const characterData = useMemo(
    () => ({
      identity: {
        era: form.era,
        name: form.name,
        occupation: form.occupation,
        age: Number(form.age) || null,
        gender: form.gender,
        residence: form.residence,
        birthplace: form.birthplace,
      },
      attributes: ["STR", "CON", "DEX", "APP", "POW", "SIZ", "INT", "EDU", "LCK"].reduce(
        (acc, key) => ({ ...acc, [key]: Number(form[key]) || 0 }),
        {}
      ),
      derived: {
        HP: Number(form.HP) || 0,
        SAN: Number(form.SAN) || 0,
        MP: Number(form.MP) || 0,
        LUCK: Number(form.LUCK) || 0,
        MOV: Number(form.MOV) || 0,
        BUILD: form.BUILD,
        DB: form.DB,
        ARMOR: form.ARMOR,
      },
      skills: skillsState.reduce(
        (acc, s) => ({
          ...acc,
          [s.name]: {
            base: parseInt(s.base.replace("%", "")) || 0,
            occupationalPoints: Number(s.occupationalValue) || 0,
            interestPoints: Number(s.interestValue) || 0,
            total: (parseInt(s.base.replace("%", "")) || 0) + (Number(s.occupationalValue) || 0) + (Number(s.interestValue) || 0)
          }
        }),
        {}
      ),
      weapons: weapons.filter((w) => w.name || w.skill || w.damage),
      items: items.filter((item) => item.name), // Filter out empty items
      notes: {
        appearance: form.appearance,
        ideology: form.ideology,
        people: form.people,
        gear: form.gear,
        backstory: form.backstory,
      },
    }),
    [form, skillsState, weapons, items]
  );

  const handleCreateCharacter = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!characterData.identity.name) {
      setSaveMessage({ type: "error", text: "Please fill in character name!" });
      return;
    }

    setSaving(true);
    setSaveMessage(null);

    try {
      const response = await fetch("/api/character", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(characterData),
      });

      const data = await response.json();

      if (response.ok) {
        setSaveMessage({ type: "success", text: data.message });

        // Wait a moment to show success message, then navigate
        setTimeout(() => {
          if (isCreatingFromGameFlow) {
            // If from game flow, return to character selection
            setPage("character-select");
          } else {
            // If from home, return to home page
            setPage("home");
          }
          // Clear form and reset state
          setForm({});
          setSaveMessage(null);
          setIsCreatingFromGameFlow(false);
        }, 1500);
      } else {
        setSaveMessage({ type: "error", text: data.error || "Failed to create character" });
      }
    } catch (error) {
      console.error("Error creating character:", error);
      setSaveMessage({ type: "error", text: "Network error, unable to connect to server" });
    } finally {
      setSaving(false);
    }
  };

  const sheet = (
    <div className="sheet">
      <h1>Call of Cthulhu Investigator Sheet</h1>
      <form onSubmit={handleCreateCharacter}>
        <div style={{ textAlign: "right", marginBottom: "6px" }}>
          <button
            type="button"
            className="pill-btn"
            onClick={() => {
              if (isCreatingFromGameFlow) {
                setPage("character-select");
              } else {
                setPage("home");
              }
              setIsCreatingFromGameFlow(false);
            }}
            style={{ background: "#eee" }}
          >
            {isCreatingFromGameFlow ? "← Back to Character Selection" : "← Return to Home"}
          </button>
        </div>
        <div className="section-title">Identity</div>
        <table>
          <tbody>
            <tr>
              <th>Era</th>
              <td>
                <input name="era" placeholder="1920s Investigator" value={form.era || ""} onChange={(e) => onChange("era", e.target.value)} />
              </td>
              <th>Name</th>
              <td>
                <input name="name" placeholder="Name" value={form.name || ""} onChange={(e) => onChange("name", e.target.value)} />
              </td>
              <th>Occupation</th>
              <td>
                <select
                  name="occupation"
                  value={form.occupation || ""}
                  onChange={(e) => {
                    const occupationName = e.target.value;
                    onChange("occupation", occupationName);

                    // Find and store the selected occupation details
                    const selected = occupations.find(occ => occ.name_en === occupationName);
                    setSelectedOccupation(selected);
                  }}
                  style={{ width: "100%", padding: "4px" }}
                >
                  <option value="">Select occupation...</option>
                  {occupations.map((occ) => (
                    <option key={occ.id} value={occ.name_en}>
                      {occ.name_en}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <th>Age</th>
              <td>
                <input name="age" type="number" min="1" placeholder="32" value={form.age || ""} onChange={(e) => onChange("age", e.target.value)} />
              </td>
              <th>Gender</th>
              <td>
                <input name="gender" placeholder="Male / Female" value={form.gender || ""} onChange={(e) => onChange("gender", e.target.value)} />
              </td>
              <th>Residence</th>
              <td>
                <input name="residence" placeholder="New York" value={form.residence || ""} onChange={(e) => onChange("residence", e.target.value)} />
              </td>
            </tr>
            <tr>
              <th>Birthplace</th>
              <td colSpan={5}>
                <input name="birthplace" placeholder="Boston" value={form.birthplace || ""} onChange={(e) => onChange("birthplace", e.target.value)} />
              </td>
            </tr>
          </tbody>
        </table>

        <div className="section-title">Attributes</div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
          <button
            type="button"
            className="pill-btn"
            onClick={handleRandomizeAttributes}
            style={{ background: "#8b7355", color: "#f5f1e8" }}
          >
            🎲 Randomize Attributes
          </button>
        </div>
        <table>
          <tbody>
            <tr>
              {[
                { key: "STR", label: "Strength" },
                { key: "CON", label: "Constitution" },
                { key: "DEX", label: "Dexterity" },
                { key: "APP", label: "Appearance" },
                { key: "POW", label: "Power" },
                { key: "SIZ", label: "Size" },
                { key: "INT", label: "Intelligence" },
                { key: "EDU", label: "Education" },
                { key: "LCK", label: "Luck" }
              ].map((attr) => (
                <th key={attr.key}>{attr.label}</th>
              ))}
            </tr>
            <tr>
              {[
                { key: "STR", label: "Strength" },
                { key: "CON", label: "Constitution" },
                { key: "DEX", label: "Dexterity" },
                { key: "APP", label: "Appearance" },
                { key: "POW", label: "Power" },
                { key: "SIZ", label: "Size" },
                { key: "INT", label: "Intelligence" },
                { key: "EDU", label: "Education" },
                { key: "LCK", label: "Luck" }
              ].map((attr) => (
                <td key={attr.key}>
                  <input
                    name={attr.key}
                    type="number"
                    min="1"
                    max="99"
                    placeholder="50"
                    value={form[attr.key] || ""}
                    onChange={(e) => onChange(attr.key, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        <table>
          <tbody>
            <tr>
              <th>HP</th>
              <td>
                <input name="HP" type="number" min="1" placeholder="10" value={form.HP || ""} onChange={(e) => onChange("HP", e.target.value)} />
              </td>
              <th>Sanity</th>
              <td>
                <input name="SAN" type="number" min="0" placeholder="60" value={form.SAN || ""} onChange={(e) => onChange("SAN", e.target.value)} />
              </td>
              <th>MP</th>
              <td>
                <input name="MP" type="number" min="0" placeholder="10" value={form.MP || ""} onChange={(e) => onChange("MP", e.target.value)} />
              </td>
              <th>Luck</th>
              <td>
                <input name="LUCK" type="number" min="0" placeholder="50" value={form.LUCK || ""} onChange={(e) => onChange("LUCK", e.target.value)} />
              </td>
            </tr>
            <tr>
              <th>Move</th>
              <td>
                <input name="MOV" type="number" min="1" placeholder="8" value={form.MOV || ""} onChange={(e) => onChange("MOV", e.target.value)} />
              </td>
              <th>Build</th>
              <td>
                <input name="BUILD" placeholder="0" value={form.BUILD || ""} onChange={(e) => onChange("BUILD", e.target.value)} />
              </td>
              <th>DB</th>
              <td>
                <input name="DB" placeholder="+0" value={form.DB || ""} onChange={(e) => onChange("DB", e.target.value)} />
              </td>
              <th>Armor</th>
              <td colSpan={3}>
                <input name="ARMOR" placeholder="-" value={form.ARMOR || ""} onChange={(e) => onChange("ARMOR", e.target.value)} />
              </td>
            </tr>
          </tbody>
        </table>

        <div className="section-title">Skills</div>

        {/* Skill Points Display */}
        <div style={{
          marginBottom: "16px",
          padding: "16px",
          background: "#fff9e6",
          border: "2px solid #8b7355",
          borderRadius: "4px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px"
        }}>
          <div>
            <strong style={{ color: "#8b7355", fontSize: "1rem" }}>Occupational Skill Points:</strong>
            <div style={{
              fontSize: "1.5rem",
              fontWeight: "bold",
              color: skillPointsUsage.occupationalRemaining < 0 ? "#c41e3a" : "#3d2817",
              marginTop: "4px"
            }}>
              Remaining: {skillPointsUsage.occupationalRemaining}
            </div>
            <div style={{ fontSize: "0.9rem", color: "#666", marginTop: "4px" }}>
              Total: {occupationalPoints} | Used: {skillPointsUsage.occupationalUsed}
            </div>
            {selectedOccupation && selectedOccupation.suggested_occupational_points && (
              <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "2px" }}>
                ({selectedOccupation.suggested_occupational_points.expression})
              </div>
            )}
            {skillPointsUsage.occupationalRemaining < 0 && (
              <div style={{ fontSize: "0.8rem", color: "#c41e3a", marginTop: "4px", fontWeight: "bold" }}>
                ⚠️ Exceeds available points!
              </div>
            )}
          </div>
          <div>
            <strong style={{ color: "#8b7355", fontSize: "1rem" }}>Interest Skill Points:</strong>
            <div style={{
              fontSize: "1.5rem",
              fontWeight: "bold",
              color: skillPointsUsage.interestRemaining < 0 ? "#c41e3a" : "#3d2817",
              marginTop: "4px"
            }}>
              Remaining: {skillPointsUsage.interestRemaining}
            </div>
            <div style={{ fontSize: "0.9rem", color: "#666", marginTop: "4px" }}>
              Total: {interestPoints} | Used: {skillPointsUsage.interestUsed}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "2px" }}>
              (INT × 2)
            </div>
            {skillPointsUsage.interestRemaining < 0 && (
              <div style={{ fontSize: "0.8rem", color: "#c41e3a", marginTop: "4px", fontWeight: "bold" }}>
                ⚠️ Exceeds available points!
              </div>
            )}
          </div>
        </div>

        <div style={{
          marginBottom: "12px",
          padding: "10px",
          background: "#e8f4f8",
          border: "1px solid #5ba3c0",
          borderRadius: "4px",
          fontSize: "0.85rem",
          color: "#2c5f75"
        }}>
          <strong>💡 Tip:</strong> Each skill can be improved using <strong>occupational points</strong> and <strong>interest points</strong> separately. Final skill value = Base value + Occupational points + Interest points
        </div>

        {selectedOccupation && selectedOccupation.suggested_skills && selectedOccupation.suggested_skills.length > 0 && (
          <div style={{
            marginBottom: "16px",
            padding: "12px",
            background: "#f0f8ff",
            border: "1px solid #8b7355",
            borderRadius: "4px"
          }}>
            <strong style={{ color: "#8b7355" }}>
              {selectedOccupation.name_en} Recommended Skills:
            </strong>
            <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {selectedOccupation.suggested_skills.map((skill: string, index: number) => (
                <span
                  key={index}
                  style={{
                    padding: "4px 8px",
                    background: "#fff",
                    border: "1px solid #ddd",
                    borderRadius: "3px",
                    fontSize: "0.85rem"
                  }}
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* Left Column */}
          <div>
            {[
              { key: "social-knowledge", label: "Social & Knowledge Skills", categories: ["Social", "Knowledge", "Language"] },
              { key: "investigation", label: "Investigation & Criminal Skills", categories: ["Investigation", "Criminal"] },
              { key: "combat", label: "Combat Skills", categories: ["Combat"] }
            ].map((group) => {
              const groupSkills = skillsState.filter((s) => group.categories.includes(s.category));
              if (groupSkills.length === 0) return null;

              return (
                <div key={group.key} className="skill-category" style={{ marginBottom: '20px' }}>
                  <h4 className="skill-category-title">{group.label}</h4>
                  <table className="skills-table">
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>Skill Name</th>
                        <th style={{ width: '80px' }}>Occupational</th>
                        <th style={{ width: '80px' }}>Interest</th>
                        <th style={{ width: '80px' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupSkills.map((skill) => {
                        const isOccupationalSkill = selectedOccupation?.suggested_skills?.includes(skill.name);
                        const baseValue = parseInt(skill.base.replace("%", "")) || 0;
                        const occValue = parseInt(skill.occupationalValue) || 0;
                        const intValue = parseInt(skill.interestValue) || 0;
                        const totalValue = baseValue + occValue + intValue;

                        return (
                          <tr
                            key={skill.name}
                            style={{
                              backgroundColor: isOccupationalSkill ? '#f5e6d3' : 'transparent'
                            }}
                          >
                            <td className="skill-name-cell">
                              <span>{skill.name}</span>
                              <span className="skill-base" style={{ marginLeft: '8px', color: '#999' }}>({skill.base})</span>
                            </td>
                            <td className="skill-value-cell">
                              <input
                                type="number"
                                min="0"
                                max="99"
                                placeholder="0"
                                value={skill.occupationalValue}
                                onChange={(e) => onChange(`skill_occ_${skill.name}`, e.target.value)}
                                style={{ width: '100%' }}
                              />
                            </td>
                            <td className="skill-value-cell">
                              <input
                                type="number"
                                min="0"
                                max="99"
                                placeholder="0"
                                value={skill.interestValue}
                                onChange={(e) => onChange(`skill_int_${skill.name}`, e.target.value)}
                                style={{ width: '100%' }}
                              />
                            </td>
                            <td className="skill-value-cell" style={{ textAlign: 'center', fontWeight: 'bold', backgroundColor: '#f0f0f0' }}>
                              {totalValue}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>

          {/* Right Column */}
          <div>
            {[
              { key: "physical", label: "Physical & Stealth Skills", categories: ["Physical", "Stealth"] },
              { key: "technical-medical", label: "Technical & Medical Skills", categories: ["Technical", "Medical"] },
              { key: "special", label: "Special Skills", categories: ["Status", "Mythos"] }
            ].map((group) => {
              const groupSkills = skillsState.filter((s) => group.categories.includes(s.category));
              if (groupSkills.length === 0) return null;

              return (
                <div key={group.key} className="skill-category" style={{ marginBottom: '20px' }}>
                  <h4 className="skill-category-title">{group.label}</h4>
                  <table className="skills-table">
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>Skill Name</th>
                        <th style={{ width: '80px' }}>Occupational</th>
                        <th style={{ width: '80px' }}>Interest</th>
                        <th style={{ width: '80px' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupSkills.map((skill) => {
                        const isOccupationalSkill = selectedOccupation?.suggested_skills?.includes(skill.name);
                        const baseValue = parseInt(skill.base.replace("%", "")) || 0;
                        const occValue = parseInt(skill.occupationalValue) || 0;
                        const intValue = parseInt(skill.interestValue) || 0;
                        const totalValue = baseValue + occValue + intValue;

                        return (
                          <tr
                            key={skill.name}
                            style={{
                              backgroundColor: isOccupationalSkill ? '#f5e6d3' : 'transparent'
                            }}
                          >
                            <td className="skill-name-cell">
                              <span>{skill.name}</span>
                              <span className="skill-base" style={{ marginLeft: '8px', color: '#999' }}>({skill.base})</span>
                            </td>
                            <td className="skill-value-cell">
                              <input
                                type="number"
                                min="0"
                                max="99"
                                placeholder="0"
                                value={skill.occupationalValue}
                                onChange={(e) => onChange(`skill_occ_${skill.name}`, e.target.value)}
                                style={{ width: '100%' }}
                              />
                            </td>
                            <td className="skill-value-cell">
                              <input
                                type="number"
                                min="0"
                                max="99"
                                placeholder="0"
                                value={skill.interestValue}
                                onChange={(e) => onChange(`skill_int_${skill.name}`, e.target.value)}
                                style={{ width: '100%' }}
                              />
                            </td>
                            <td className="skill-value-cell" style={{ textAlign: 'center', fontWeight: 'bold', backgroundColor: '#f0f0f0' }}>
                              {totalValue}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>

        <div className="section-title">Weapons</div>
        <table>
          <tbody>
            <tr>
              <th>Weapon</th>
              <th>Skill</th>
              <th>Damage</th>
              <th>Range</th>
              <th>Attk/Rd</th>
              <th>Ammo</th>
            </tr>
            {weapons.map((w, i) => (
              <tr className="weapon-row" key={i}>
                <td>
                  <select
                    name={`weapon_${i}_name`}
                    value={w.name}
                    onChange={(e) => {
                      const selectedWeaponName = e.target.value;
                      onChange(`weapon_${i}_name`, selectedWeaponName);

                      // Auto-fill weapon stats if a predefined weapon is selected
                      if (selectedWeaponName) {
                        const selectedWeapon = weaponsList.find(weapon => weapon.name === selectedWeaponName);
                        if (selectedWeapon) {
                          onChange(`weapon_${i}_skill`, selectedWeapon.skill);
                          onChange(`weapon_${i}_damage`, selectedWeapon.damage);
                          onChange(`weapon_${i}_range`, selectedWeapon.range);
                          onChange(`weapon_${i}_attacks`, String(selectedWeapon.attacks_per_round));
                          onChange(`weapon_${i}_ammo`, selectedWeapon.ammo ? String(selectedWeapon.ammo) : "");
                        }
                      }
                    }}
                    style={{ width: "100%", padding: "4px" }}
                  >
                    <option value="">-- Select Weapon --</option>
                    {weaponsList.map((weapon) => (
                      <option key={weapon.name} value={weapon.name}>
                        {weapon.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    name={`weapon_${i}_skill`}
                    placeholder={i === 0 ? "Handgun" : "Skill"}
                    value={w.skill}
                    onChange={(e) => onChange(`weapon_${i}_skill`, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    name={`weapon_${i}_damage`}
                    placeholder={i === 0 ? "1d10" : "-"}
                    value={w.damage}
                    onChange={(e) => onChange(`weapon_${i}_damage`, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    name={`weapon_${i}_range`}
                    placeholder={i === 0 ? "15" : "-"}
                    value={w.range}
                    onChange={(e) => onChange(`weapon_${i}_range`, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    name={`weapon_${i}_attacks`}
                    placeholder={i === 0 ? "1" : "-"}
                    value={w.attacks}
                    onChange={(e) => onChange(`weapon_${i}_attacks`, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    name={`weapon_${i}_ammo`}
                    placeholder={i === 0 ? "6" : "-"}
                    value={w.ammo}
                    onChange={(e) => onChange(`weapon_${i}_ammo`, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="section-title">Items & Equipment</div>
        <table>
          <tbody>
            <tr>
              <th>Item Name</th>
              <th style={{ width: '100px' }}>Quantity</th>
              <th>Description</th>
            </tr>
            {items.map((item, i) => (
              <tr className="item-row" key={i}>
                <td>
                  <input
                    name={`item_${i}_name`}
                    placeholder={i === 0 ? "Flashlight" : "Item name"}
                    value={item.name}
                    onChange={(e) => onChange(`item_${i}_name`, e.target.value)}
                    style={{ width: "100%" }}
                  />
                </td>
                <td>
                  <input
                    name={`item_${i}_quantity`}
                    type="number"
                    min="1"
                    placeholder={i === 0 ? "1" : "-"}
                    value={item.quantity || ""}
                    onChange={(e) => onChange(`item_${i}_quantity`, e.target.value)}
                    style={{ width: "100%" }}
                  />
                </td>
                <td>
                  <input
                    name={`item_${i}_description`}
                    placeholder={i === 0 ? "Battery-powered, heavy" : "Optional description"}
                    value={item.properties?.description || ""}
                    onChange={(e) => onChange(`item_${i}_description`, e.target.value)}
                    style={{ width: "100%" }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="section-title">Portrait & Notes</div>
        <div className="notes-grid">
          <table>
            <tbody>
              <tr>
                <th>Appearance</th>
              </tr>
              <tr>
                <td>
                  <textarea
                    name="appearance"
                    placeholder="Describe appearance, attire, scars, mannerisms..."
                    value={form.appearance || ""}
                    onChange={(e) => onChange("appearance", e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <table>
            <tbody>
              <tr>
                <th>Traits / Ideology</th>
              </tr>
              <tr>
                <td>
                  <textarea
                    name="ideology"
                    placeholder="Beliefs, politics, religion, personality quirks..."
                    value={form.ideology || ""}
                    onChange={(e) => onChange("ideology", e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <table>
            <tbody>
              <tr>
                <th>Significant People</th>
              </tr>
              <tr>
                <td>
                  <textarea
                    name="people"
                    placeholder="Important people, mentors, family, contacts..."
                    value={form.people || ""}
                    onChange={(e) => onChange("people", e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <table>
            <tbody>
              <tr>
                <th>Gear & Assets</th>
              </tr>
              <tr>
                <td>
                  <textarea
                    name="gear"
                    placeholder="Equipment, items, assets, funds..."
                    value={form.gear || ""}
                    onChange={(e) => onChange("gear", e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="section-title">Background Story</div>
        <table>
          <tbody>
            <tr>
              <td>
                <textarea
                  name="backstory"
                  placeholder="Background story, cases, motivations, fears, secrets..."
                  value={form.backstory || ""}
                  onChange={(e) => onChange("backstory", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>

        {saveMessage && (
          <div
            style={{
              marginTop: "12px",
              padding: "12px",
              borderRadius: "4px",
              backgroundColor: saveMessage.type === "success" ? "#d4edda" : "#f8d7da",
              color: saveMessage.type === "success" ? "#155724" : "#721c24",
              border: `1px solid ${saveMessage.type === "success" ? "#c3e6cb" : "#f5c6cb"}`,
            }}
          >
            {saveMessage.text}
          </div>
        )}
        <div style={{ marginTop: "20px", textAlign: "center", display: "flex", gap: "12px", justifyContent: "center" }}>
          {saveMessage && (
            <button
              className="pill-btn"
              type="button"
              onClick={() => setSaveMessage(null)}
              style={{ background: "#8b7355", borderColor: "#8b7355", color: "#f5f1e8" }}
            >
              Clear Message
            </button>
          )}
          <button className="pill-btn" type="submit" disabled={saving}>
            {saving ? "Creating..." : "🎲 Create Character"}
          </button>
        </div>
      </form>

      {/* Attribute Selector Modal */}
      {showAttributeSelector && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px',
        }}>
          <div style={{
            backgroundColor: '#f5f1e8',
            padding: '30px',
            borderRadius: '8px',
            maxWidth: '1200px',
            width: '95%',
            maxHeight: '90vh',
            overflow: 'auto',
            border: '3px solid #8b7355',
            boxShadow: '0 8px 20px rgba(0, 0, 0, 0.4)',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px'
            }}>
              <h2 style={{
                margin: 0,
                color: '#3d2817',
                fontSize: '1.6rem'
              }}>
                🎲 Select Attribute Set
              </h2>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '15px'
              }}>
                <span style={{
                  fontSize: '0.9rem',
                  color: '#666',
                  fontWeight: 'bold'
                }}>
                  Generated: {attributeOptions.length}/5
                </span>
                <button
                  onClick={handleGenerateAnotherSet}
                  disabled={attributeOptions.length >= 5}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: attributeOptions.length >= 5 ? '#ccc' : '#8b7355',
                    color: '#f5f1e8',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: attributeOptions.length >= 5 ? 'not-allowed' : 'pointer',
                    fontSize: '0.9rem',
                    fontWeight: 'bold',
                    transition: 'background-color 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (attributeOptions.length < 5) {
                      e.currentTarget.style.backgroundColor = '#6b5a45';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (attributeOptions.length < 5) {
                      e.currentTarget.style.backgroundColor = '#8b7355';
                    }
                  }}
                >
                  {attributeOptions.length >= 5 ? 'Maximum reached' : '🎲 Generate Another Set'}
                </button>
              </div>
            </div>

            <div style={{
              padding: '12px',
              background: '#e8f4f8',
              border: '1px solid #5ba3c0',
              borderRadius: '4px',
              marginBottom: '15px',
              fontSize: '0.9rem',
              color: '#2c5f75',
              textAlign: 'center'
            }}>
              💡 Click a card to select that attribute set, or click "Generate Another Set" to continue generating (max 5 sets)
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '15px',
              marginBottom: '20px'
            }}>
              {attributeOptions.map((option) => {
                const attrs = option.attributes;
                const total = (attrs.STR || 0) + (attrs.CON || 0) + (attrs.DEX || 0) +
                             (attrs.APP || 0) + (attrs.POW || 0) + (attrs.SIZ || 0) +
                             (attrs.INT || 0) + (attrs.EDU || 0) + (attrs.LCK || 0);

                return (
                  <div
                    key={option.id}
                    onClick={() => handleSelectAttributeSet(attrs)}
                    style={{
                      padding: '15px',
                      border: '2px solid #8b7355',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      backgroundColor: '#fff',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f0ebe0';
                      e.currentTarget.style.transform = 'scale(1.02)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#fff';
                      e.currentTarget.style.transform = 'scale(1)';
                    }}
                  >
                    <div style={{
                      fontWeight: 'bold',
                      fontSize: '1.1rem',
                      marginBottom: '10px',
                      color: '#8b7355',
                      textAlign: 'center',
                      borderBottom: '1px solid #ddd',
                      paddingBottom: '8px'
                    }}>
                      Set {option.id}
                    </div>

                    <table style={{ width: '100%', fontSize: '0.85rem' }}>
                      <tbody>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>STR:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.STR}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>CON:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.CON}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>DEX:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.DEX}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>APP:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.APP}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>POW:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.POW}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>SIZ:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.SIZ}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>INT:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.INT}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>EDU:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.EDU}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: '2px 4px', fontWeight: '500' }}>LCK:</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right' }}>{attrs.LCK}</td>
                        </tr>
                        <tr style={{ borderTop: '1px solid #ddd' }}>
                          <td style={{ padding: '4px 4px 2px', fontWeight: 'bold' }}>Total:</td>
                          <td style={{ padding: '4px 4px 2px', textAlign: 'right', fontWeight: 'bold' }}>{total}</td>
                        </tr>
                      </tbody>
                    </table>

                    <div style={{
                      marginTop: '10px',
                      padding: '8px',
                      background: '#f9f9f9',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      color: '#666'
                    }}>
                      <div><strong>HP:</strong> {attrs.HP}</div>
                      <div><strong>MP:</strong> {attrs.MP}</div>
                      <div><strong>SAN:</strong> {attrs.SAN}</div>
                      <div><strong>MOV:</strong> {attrs.MOV}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => {
                setShowAttributeSelector(false);
                setAttributeOptions([]);
              }}
              style={{
                width: '100%',
                padding: '12px 20px',
                backgroundColor: '#6b5a45',
                color: '#f5f1e8',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: 'bold',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );

  if (page === "home") {
    return (
      <>
        {userMenu}
        <Homes
          onCreate={() => {
            setIsCreatingFromGameFlow(false);
            setPage("sheet");
          }}
          onStartGame={handleShowCharacterSelector}
          onContinueGame={handleContinueGame}
        />
        {showCheckpointSelector && (
          <div className="checkpoint-selector-overlay" style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}>
            <div className="checkpoint-selector" style={{
              backgroundColor: '#f5f1e8',
              padding: '30px',
              borderRadius: '8px',
              maxWidth: '600px',
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto',
              border: '3px solid #8b7355',
              boxShadow: '0 8px 20px rgba(0, 0, 0, 0.3)',
            }}>
              <h2 style={{ marginTop: 0, marginBottom: '20px', color: '#3d2817' }}>📂 Select Checkpoint</h2>
              
              {loadingCheckpoints ? (
                <p>Loading checkpoint list...</p>
              ) : checkpoints.length === 0 ? (
                <p style={{ color: '#666' }}>No checkpoints available</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {checkpoints.map((checkpoint: any) => (
                    <div
                      key={checkpoint.checkpointId}
                      onClick={() => handleLoadCheckpoint(checkpoint.checkpointId)}
                      style={{
                        padding: '15px',
                        border: '2px solid #8b7355',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        backgroundColor: '#fff',
                        transition: 'background-color 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = '#f0ebe0';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = '#fff';
                      }}
                    >
                      <div style={{ fontWeight: 'bold', marginBottom: '5px', color: '#3d2817' }}>
                        {checkpoint.checkpointName || 'Unnamed Checkpoint'}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#666' }}>
                        {checkpoint.currentSceneName && `Scene: ${checkpoint.currentSceneName}`}
                        {checkpoint.currentLocation && ` | Location: ${checkpoint.currentLocation}`}
                        {checkpoint.gameDay && ` | Day ${checkpoint.gameDay}`}
                        {checkpoint.gameTime && ` | ${checkpoint.gameTime}`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#999', marginTop: '5px' }}>
                        {checkpoint.createdAt && new Date(checkpoint.createdAt).toLocaleString('en-US')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              <button
                onClick={() => setShowCheckpointSelector(false)}
                style={{
                  marginTop: '20px',
                  padding: '10px 20px',
                  backgroundColor: '#8b7355',
                  color: '#f5f1e8',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '1rem',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  if (page === "mod-select") {
    return (
      <>
        {userMenu}
        <ModSelector
          onSelectMod={handleSelectMod}
          onCancel={handleBackToHome}
        />
        
        {/* Loading Progress Modal */}
        {loadingModData && (
          <div className="mod-loading-overlay" style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3000,
            padding: '20px',
          }}>
            <div className="mod-loading-modal" style={{
              backgroundColor: '#f5f1e8',
              padding: '40px',
              borderRadius: '8px',
              maxWidth: '500px',
              width: '90%',
              border: '3px solid #8b7355',
              boxShadow: '0 8px 20px rgba(0, 0, 0, 0.5)',
              fontFamily: 'serif',
            }}>
              <h2 style={{ 
                marginTop: 0, 
                marginBottom: '30px', 
                color: '#3d2817',
                fontSize: '1.8rem',
                textAlign: 'center',
              }}>
                📦 Loading Module Data
              </h2>
              
              {modLoadProgress && (
                <>
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '10px',
                      fontSize: '0.9rem',
                      color: '#5a4a3a',
                    }}>
                      <span>{modLoadProgress.stage}</span>
                      <span>{modLoadProgress.progress}%</span>
                    </div>
                    <div style={{
                      width: '100%',
                      height: '24px',
                      backgroundColor: '#ddd',
                      borderRadius: '12px',
                      overflow: 'hidden',
                      border: '2px solid #8b7355',
                    }}>
                      <div style={{
                        width: `${modLoadProgress.progress}%`,
                        height: '100%',
                        backgroundColor: '#8b7355',
                        transition: 'width 0.3s ease',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#f5f1e8',
                        fontSize: '0.8rem',
                        fontWeight: 'bold',
                      }}>
                        {modLoadProgress.progress >= 10 && `${modLoadProgress.progress}%`}
                      </div>
                    </div>
                  </div>
                  
                  <div style={{
                    textAlign: 'center',
                    color: '#5a4a3a',
                    fontSize: '1rem',
                    minHeight: '40px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {modLoadProgress.message}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  if (page === "module-intro") {
    return (
      <>
        {userMenu}
        <div className="module-intro-overlay" style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px',
        }}>
          <div className="module-intro-modal" style={{
            backgroundColor: '#f5f1e8',
            padding: '40px',
            borderRadius: '8px',
            maxWidth: '800px',
            width: '90%',
            maxHeight: '90vh',
            overflow: 'auto',
            border: '3px solid #8b7355',
            boxShadow: '0 8px 20px rgba(0, 0, 0, 0.5)',
            fontFamily: 'serif',
          }}>
            <h2 style={{ 
              marginTop: 0, 
              marginBottom: '20px', 
              color: '#3d2817',
              fontSize: '1.8rem',
              borderBottom: '2px solid #8b7355',
              paddingBottom: '10px'
            }}>
              📖 Module Introduction
            </h2>
            
            {moduleIntroduction && (
              <>
                <div style={{ marginBottom: '30px' }}>
                  <h3 style={{ color: '#5a4a3a', marginBottom: '10px', fontSize: '1.2rem' }}>
                    Story Introduction
                  </h3>
                  <div style={{
                    backgroundColor: '#fff',
                    padding: '20px',
                    borderRadius: '4px',
                    border: '1px solid #ddd',
                    lineHeight: '1.8',
                    color: '#2c2c2c',
                    whiteSpace: 'pre-wrap',
                  }}>
                    {moduleIntroduction.introduction}
                  </div>
                </div>

                <div style={{ marginBottom: '30px' }}>
                  <h3 style={{ color: '#5a4a3a', marginBottom: '10px', fontSize: '1.2rem' }}>
                    📝 Character Creation Guide
                  </h3>
                  <div style={{
                    backgroundColor: '#fff',
                    padding: '20px',
                    borderRadius: '4px',
                    border: '1px solid #ddd',
                    lineHeight: '1.8',
                    color: '#2c2c2c',
                    whiteSpace: 'pre-wrap',
                  }}>
                    {moduleIntroduction.moduleNotes}
                  </div>
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setPage("mod-select")}
                style={{
                  flex: 1,
                  padding: '15px 20px',
                  backgroundColor: '#6b5a45',
                  color: '#f5f1e8',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '1.1rem',
                  fontWeight: 'bold',
                  transition: 'background-color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#5a4a3a';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#6b5a45';
                }}
              >
                Back to Module Selection
              </button>
              <button
                onClick={() => setPage("character-select")}
                style={{
                  flex: 2,
                  padding: '15px 20px',
                  backgroundColor: '#8b7355',
                  color: '#f5f1e8',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '1.1rem',
                  fontWeight: 'bold',
                  transition: 'background-color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#6b5a45';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#8b7355';
                }}
              >
                Next: Select Character
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (page === "character-select") {
    return (
      <>
        {userMenu}
        <CharacterSelector
          onSelectCharacter={handleSelectCharacter}
          onCancel={() => setPage("module-intro")}
          onCreateNew={() => {
            setIsCreatingFromGameFlow(true);
            setPage("sheet");
          }}
        />
      </>
    );
  }
  
  if (page === "game") {
    return (
      <>
        {userMenu}
        <div className="game-container">
          <div className="game-header">
            <h1>Call of Cthulhu - Game Session</h1>
            <button className="back-button" onClick={handleBackToHome}>
              ← Back to Home
            </button>
          </div>
          <div className="game-main-layout">
            <GameChat
              sessionId={sessionId}
              apiBaseUrl="/api"
              characterName={characterName}
              moduleIntroduction={moduleIntroduction}
              initialMessages={conversationHistory || undefined}
              onNarrativeComplete={() => setSidebarRefreshTrigger(prev => prev + 1)}
            />
            <GameSidebar
              sessionId={sessionId}
              apiBaseUrl="/api"
              refreshTrigger={sidebarRefreshTrigger}
            />
          </div>
        </div>
      </>
    );
  }
  
  return (
    <>
      {userMenu}
      {sheet}
    </>
  );
};

const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        />
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
