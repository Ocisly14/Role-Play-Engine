import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SKILLS } from "../constants/skills";
import { authFetch } from "../utils/authFetch";

interface UseCharacterCreationProps {
  onCharacterCreated?: (characterId: string) => void;
  characterId?: string;
}

const OCCUPATIONAL_ATTRIBUTES = [
  "STR",
  "CON",
  "DEX",
  "APP",
  "POW",
  "SIZ",
  "INT",
  "EDU",
] as const;

type DerivedAttributes = {
  HP: number | "";
  SAN: number | "";
  MP: number | "";
  LUCK: number | "";
  MOV: number | "";
  BUILD: number | "";
  DB: string;
  ARMOR: string;
};

const DERIVED_ATTRIBUTE_KEYS = new Set([
  "HP",
  "SAN",
  "MP",
  "LUCK",
  "MOV",
  "BUILD",
  "DB",
  "ARMOR",
]);

function getNumericAttributeValue(
  form: Record<string, string>,
  key: string
): number | null {
  const value = Number(form[key]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function calculateDerivedAttributes(
  form: Record<string, string>
): DerivedAttributes {
  const STR = getNumericAttributeValue(form, "STR");
  const CON = getNumericAttributeValue(form, "CON");
  const DEX = getNumericAttributeValue(form, "DEX");
  const POW = getNumericAttributeValue(form, "POW");
  const SIZ = getNumericAttributeValue(form, "SIZ");
  const LCK = getNumericAttributeValue(form, "LCK");

  const HP = CON !== null && SIZ !== null ? Math.floor((CON + SIZ) / 10) : "";
  const MP = POW !== null ? Math.floor(POW / 5) : "";
  const SAN = POW !== null ? POW : "";
  const LUCK = LCK !== null ? LCK : "";

  let MOV: number | "" = "";
  if (STR !== null && DEX !== null && SIZ !== null) {
    MOV = 8;
    if (DEX < SIZ && STR < SIZ) {
      MOV = 7;
    } else if (DEX >= SIZ && STR >= SIZ) {
      MOV = 9;
    }
  }

  let BUILD: number | "" = "";
  let DB = "";
  if (STR !== null && SIZ !== null) {
    const buildSum = STR + SIZ;
    if (buildSum >= 2 && buildSum <= 64) {
      BUILD = -2;
      DB = "-2";
    } else if (buildSum >= 65 && buildSum <= 84) {
      BUILD = -1;
      DB = "-1";
    } else if (buildSum >= 85 && buildSum <= 124) {
      BUILD = 0;
      DB = "0";
    } else if (buildSum >= 125 && buildSum <= 164) {
      BUILD = 1;
      DB = "+1d4";
    } else if (buildSum >= 165 && buildSum <= 204) {
      BUILD = 2;
      DB = "+1d6";
    } else if (buildSum >= 205 && buildSum <= 284) {
      BUILD = 3;
      DB = "+2d6";
    } else if (buildSum >= 285 && buildSum <= 364) {
      BUILD = 4;
      DB = "+3d6";
    } else if (buildSum >= 365 && buildSum <= 444) {
      BUILD = 5;
      DB = "+4d6";
    } else if (buildSum >= 445) {
      BUILD = 6;
      DB = "+5d6";
    }
  }

  return {
    HP,
    SAN,
    MP,
    LUCK,
    MOV,
    BUILD,
    DB,
    ARMOR: "-",
  };
}

function calculateOccupationalPointsFromExpression(
  occupation: any,
  form: Record<string, string>
): number {
  const expression = occupation?.suggested_occupational_points?.expression;
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return 0;
  }

  // Allow only simple math expressions with known attribute identifiers.
  if (!/^[A-Z0-9+\-*/().\s]+$/.test(expression)) {
    return 0;
  }

  let evaluated = expression;
  for (const attr of OCCUPATIONAL_ATTRIBUTES) {
    const attrValue = Number(form[attr] ?? 0) || 0;
    evaluated = evaluated.replace(
      new RegExp(`\\b${attr}\\b`, "g"),
      String(attrValue)
    );
  }

  // After substitution, only numeric math symbols should remain.
  if (!/^[0-9+\-*/().\s]+$/.test(evaluated)) {
    return 0;
  }

  try {
    const value = Number(Function(`"use strict"; return (${evaluated});`)());
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.floor(value);
  } catch {
    return 0;
  }
}

function mapCharacterToForm(character: any): Record<string, string> {
  const formData: Record<string, string> = {};
  const notes = character?.notes || {};
  const attributes = character?.attributes || {};
  const skills = character?.skills || {};
  const skillsDetail = character?.skillsDetail || {};
  const weapons = Array.isArray(character?.weapons) ? character.weapons : [];
  const items = Array.isArray(character?.items) ? character.items : [];

  formData.name = character?.name || "";
  formData.occupation = character?.occupation || "";
  formData.age =
    typeof character?.age === "number" ? String(character.age) : "";
  formData.gender = character?.gender || notes.gender || "";
  formData.era = notes.era || "";
  formData.residence = notes.residence || "";
  formData.birthplace = notes.birthplace || "";
  formData.appearance = notes.appearance || "";
  formData.ideology = notes.ideology || "";
  formData.people = notes.people || "";
  formData.gear = notes.gear || "";
  formData.backstory = notes.backstory || "";

  for (const key of [
    "STR",
    "CON",
    "DEX",
    "APP",
    "POW",
    "SIZ",
    "INT",
    "EDU",
    "LCK",
  ]) {
    const value = Number(attributes[key]);
    formData[key] = Number.isFinite(value) && value > 0 ? String(value) : "";
  }

  SKILLS.forEach((skill) => {
    const detail = skillsDetail[skill.name];
    const detailOcc = Number(detail?.occupationalPoints);
    const detailInt = Number(detail?.interestPoints);

    if (Number.isFinite(detailOcc) || Number.isFinite(detailInt)) {
      const occ = Number.isFinite(detailOcc) ? Math.max(detailOcc, 0) : 0;
      const int = Number.isFinite(detailInt) ? Math.max(detailInt, 0) : 0;
      formData[`skill_occ_${skill.name}`] = occ > 0 ? String(occ) : "";
      formData[`skill_int_${skill.name}`] = int > 0 ? String(int) : "";
      return;
    }

    // Backward-compatibility for legacy data without stored breakdown.
    const skillValue = Number(skills[skill.name]);
    let base = Number.parseInt(skill.base.replace("%", "")) || 0;
    if (skill.name === "Dodge") {
      const dex = Number(attributes.DEX);
      base = Number.isFinite(dex) && dex > 0 ? Math.floor(dex / 2) : 0;
    } else if (skill.name === "Language (Own)") {
      const edu = Number(attributes.EDU);
      base = Number.isFinite(edu) && edu > 0 ? edu : 0;
    }
    const extra = Number.isFinite(skillValue)
      ? Math.max(skillValue - base, 0)
      : 0;

    formData[`skill_occ_${skill.name}`] = extra > 0 ? String(extra) : "";
    formData[`skill_int_${skill.name}`] = "";
  });

  [0, 1, 2].forEach((index) => {
    const weapon = weapons[index];
    formData[`weapon_${index}_name`] = weapon?.name || "";
    formData[`weapon_${index}_skill`] = weapon?.skill || "";
    formData[`weapon_${index}_damage`] = weapon?.damage || "";
    formData[`weapon_${index}_range`] = weapon?.range || "";
    formData[`weapon_${index}_attacks`] = weapon?.attacks || "";
    formData[`weapon_${index}_ammo`] = weapon?.ammo || "";
  });

  [0, 1, 2, 3, 4].forEach((index) => {
    const item = items[index];
    formData[`item_${index}_name`] = item?.name || "";
    formData[`item_${index}_quantity`] =
      typeof item?.quantity === "number" ? String(item.quantity) : "";
    formData[`item_${index}_description`] = item?.properties?.description || "";
  });

  return formData;
}

export const useCharacterCreation = ({
  onCharacterCreated,
  characterId,
}: UseCharacterCreationProps = {}) => {
  const { t } = useTranslation(["character", "common"]);
  const isEditMode = Boolean(characterId);
  // Form state
  const [form, setForm] = useState<Record<string, string>>({});
  const [loadingCharacter, setLoadingCharacter] = useState(isEditMode);

  // Occupation and skills
  const [occupations, setOccupations] = useState<any[]>([]);
  const [selectedOccupation, setSelectedOccupation] = useState<any>(null);
  const [occupationalPoints, setOccupationalPoints] = useState<number>(0);
  const [interestPoints, setInterestPoints] = useState<number>(0);

  // Weapons list
  const [weaponsList, setWeaponsList] = useState<any[]>([]);

  // Attribute selector state
  const [showAttributeSelector, setShowAttributeSelector] = useState(false);
  const [attributeOptions, setAttributeOptions] = useState<any[]>([]);

  // Saving state
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Load existing character when in edit mode.
  useEffect(() => {
    const fetchCharacter = async () => {
      if (!characterId) {
        setLoadingCharacter(false);
        return;
      }

      setLoadingCharacter(true);
      setSaveMessage(null);

      try {
        const response = await authFetch(
          `/api/character/${encodeURIComponent(characterId)}`
        );
        const data = await response.json();

        if (response.ok && data.success && data.character) {
          setForm(mapCharacterToForm(data.character));
        } else {
          throw new Error(data.error || t("common:error.generic"));
        }
      } catch (error) {
        console.error("Error loading character for edit:", error);
        setSaveMessage({
          type: "error",
          text: `${t("character:sheet.loadError")}: ${
            error instanceof Error ? error.message : t("common:error.generic")
          }`,
        });
      } finally {
        setLoadingCharacter(false);
      }
    };

    fetchCharacter();
  }, [characterId, t]);

  // Fetch occupations on mount
  useEffect(() => {
    const fetchOccupations = async () => {
      try {
        const response = await authFetch("/api/occupations");
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

  // Fetch weapons on mount
  useEffect(() => {
    const fetchWeapons = async () => {
      try {
        const response = await authFetch("/api/weapons");
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

  // Update skill points when occupation or attributes change
  useEffect(() => {
    if (selectedOccupation) {
      setOccupationalPoints(
        calculateOccupationalPointsFromExpression(selectedOccupation, form)
      );
    } else {
      setOccupationalPoints(0);
    }

    const intValue = Number(form.INT) || 0;
    setInterestPoints(intValue * 2);
  }, [selectedOccupation, form]);

  // Keep selectedOccupation in sync with form value and loaded occupation list.
  useEffect(() => {
    const formOccupation = (form.occupation || "").trim();
    if (!formOccupation) {
      if (selectedOccupation) {
        setSelectedOccupation(null);
      }
      return;
    }

    const normalized = formOccupation.toLowerCase();
    const matched = occupations.find((occ) => {
      const en =
        typeof occ.name_en === "string" ? occ.name_en.trim().toLowerCase() : "";
      const zh =
        typeof occ.name_zh === "string" ? occ.name_zh.trim().toLowerCase() : "";
      return en === normalized || zh === normalized;
    });

    if (!matched) {
      return;
    }

    if (!selectedOccupation || selectedOccupation.id !== matched.id) {
      setSelectedOccupation(matched);
    }
  }, [form.occupation, occupations, selectedOccupation]);

  // Handle form changes
  const onChange = useCallback((key: string, value: string) => {
    if (DERIVED_ATTRIBUTE_KEYS.has(key)) {
      return;
    }
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Handle occupation selection
  const handleOccupationSelect = useCallback(
    (occupation: any) => {
      if (!occupation) {
        setSelectedOccupation(null);
        onChange("occupation", "");
        return;
      }

      setSelectedOccupation(occupation);
      onChange("occupation", occupation.name_en || occupation.name_zh || "");
    },
    [onChange]
  );

  // Calculate skills state
  const skillsState = useMemo(() => {
    const dex = Number(form.DEX);
    const dodgeBase = Number.isFinite(dex) && dex > 0 ? Math.floor(dex / 2) : 0;
    const edu = Number(form.EDU);
    const ownLangBase = Number.isFinite(edu) && edu > 0 ? edu : 0;

    return SKILLS.map((skill) => {
      let base = skill.base;
      if (skill.name === "Dodge") base = `${dodgeBase}%`;
      else if (skill.name === "Language (Own)") base = `${ownLangBase}%`;
      return {
        name: skill.name,
        base,
        category: skill.category,
        occupationalValue: form[`skill_occ_${skill.name}`] || "",
        interestValue: form[`skill_int_${skill.name}`] || "",
      };
    });
  }, [form]);

  // Calculate used skill points
  const skillPointsUsage = useMemo(() => {
    let occupationalUsed = 0;
    let interestUsed = 0;

    skillsState.forEach((skill) => {
      const occupationalValue = Number.parseInt(skill.occupationalValue) || 0;
      const interestValue = Number.parseInt(skill.interestValue) || 0;

      occupationalUsed += occupationalValue;
      interestUsed += interestValue;
    });

    return {
      occupationalUsed,
      interestUsed,
      occupationalRemaining: occupationalPoints - occupationalUsed,
      interestRemaining: interestPoints - interestUsed,
    };
  }, [skillsState, occupationalPoints, interestPoints]);

  const derivedAttributes = useMemo(
    () => calculateDerivedAttributes(form),
    [form]
  );

  // Prepare weapons data
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
    quantity: form[`item_${i}_quantity`]
      ? Number(form[`item_${i}_quantity`])
      : undefined,
    properties: form[`item_${i}_description`]
      ? { description: form[`item_${i}_description`] }
      : undefined,
  }));

  // Prepare character data
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
      attributes: [
        "STR",
        "CON",
        "DEX",
        "APP",
        "POW",
        "SIZ",
        "INT",
        "EDU",
        "LCK",
      ].reduce((acc, key) => ({ ...acc, [key]: Number(form[key]) || 0 }), {}),
      derived: {
        HP: Number(derivedAttributes.HP) || 0,
        SAN: Number(derivedAttributes.SAN) || 0,
        MP: Number(derivedAttributes.MP) || 0,
        LUCK: Number(derivedAttributes.LUCK) || 0,
        MOV: Number(derivedAttributes.MOV) || 0,
        BUILD:
          typeof derivedAttributes.BUILD === "number"
            ? derivedAttributes.BUILD
            : 0,
        DB: derivedAttributes.DB || "0",
        ARMOR: derivedAttributes.ARMOR || "-",
      },
      skills: skillsState.reduce(
        (acc, s) => ({
          ...acc,
          [s.name]: {
            base: Number.parseInt(s.base.replace("%", "")) || 0,
            occupationalPoints: Number(s.occupationalValue) || 0,
            interestPoints: Number(s.interestValue) || 0,
            total:
              (Number.parseInt(s.base.replace("%", "")) || 0) +
              (Number(s.occupationalValue) || 0) +
              (Number(s.interestValue) || 0),
          },
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
    [form, skillsState, weapons, items, derivedAttributes]
  );

  // Handle random attribute generation
  const handleRandomizeAttributes = async () => {
    try {
      const age = Number(form.age) || undefined;
      const response = await authFetch("/api/character/random-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ age }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setAttributeOptions([{ id: 1, attributes: data.attributes }]);
        setShowAttributeSelector(true);
      } else {
        alert(
          `${t("character:attributes.selector.errors.generateFailed")}: ${
            data.error || t("common:error.generic")
          }`
        );
      }
    } catch (error) {
      console.error("Error generating random attributes:", error);
      alert(t("character:attributes.selector.errors.networkGenerateFailed"));
    }
  };

  // Handle attribute set selection
  const handleSelectAttributeSet = useCallback((attributes: any) => {
    setForm((prev) => ({
      ...prev,
      ...attributes,
    }));
    setShowAttributeSelector(false);
    setAttributeOptions([]);
  }, []);

  // Handle character save (create / update)
  const handleCreateCharacter = async () => {
    if (!form.name) {
      setSaveMessage({
        type: "error",
        text: t("character:validation.nameRequired"),
      });
      return;
    }

    setSaving(true);
    setSaveMessage(null);

    try {
      const endpoint = isEditMode
        ? `/api/character/${encodeURIComponent(characterId || "")}`
        : "/api/character";
      const method = isEditMode ? "PUT" : "POST";

      const response = await authFetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(characterData),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSaveMessage({
          type: "success",
          text: isEditMode
            ? t("character:form.updateSuccess")
            : t("character:form.success"),
        });

        if (onCharacterCreated && data.characterId) {
          onCharacterCreated(data.characterId);
        }
      } else {
        setSaveMessage({
          type: "error",
          text: `${
            isEditMode
              ? t("character:form.updateFailed")
              : t("character:form.failed")
          }: ${data.error || t("common:error.generic")}`,
        });
      }
    } catch (error) {
      console.error("Error saving character:", error);
      setSaveMessage({
        type: "error",
        text: t("common:error.network"),
      });
    } finally {
      setSaving(false);
    }
  };

  return {
    // Form state
    form,
    onChange,
    isEditMode,
    loadingCharacter,

    // Occupation
    occupations,
    selectedOccupation,
    handleOccupationSelect,

    // Skill points
    occupationalPoints,
    interestPoints,
    skillsState,
    skillPointsUsage,

    // Weapons
    weaponsList,
    weapons,

    // Attributes
    derivedAttributes,
    showAttributeSelector,
    setShowAttributeSelector,
    attributeOptions,
    setAttributeOptions,
    handleRandomizeAttributes,
    handleSelectAttributeSet,

    // Character data
    characterData,

    // Saving
    saving,
    saveMessage,
    setSaveMessage,
    handleCreateCharacter,
  };
};
