import { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../utils/authFetch";
import { SKILLS } from "../constants/skills";

interface UseCharacterCreationProps {
  onCharacterCreated?: (characterId: string) => void;
}

export const useCharacterCreation = ({
  onCharacterCreated,
}: UseCharacterCreationProps = {}) => {
  const { t } = useTranslation(["character", "common"]);
  // Form state
  const [form, setForm] = useState<Record<string, string>>({});

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
    if (selectedOccupation && form.EDU) {
      const eduValue = Number(form.EDU) || 0;
      const occupationalPoints = eduValue * selectedOccupation.skillPointMultiplier;
      setOccupationalPoints(occupationalPoints);
    }

    if (form.INT) {
      const intValue = Number(form.INT) || 0;
      setInterestPoints(intValue * 2);
    }
  }, [selectedOccupation, form.EDU, form.INT]);

  // Handle form changes
  const onChange = useCallback((key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Handle occupation selection
  const handleOccupationSelect = useCallback((occupation: any) => {
    setSelectedOccupation(occupation);
    onChange("occupation", occupation.name);
  }, [onChange]);

  // Calculate skills state
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
            total:
              (parseInt(s.base.replace("%", "")) || 0) +
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
    [form, skillsState, weapons, items]
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

  // Handle character creation
  const handleCreateCharacter = async () => {
    if (!form.name) {
      setSaveMessage({ type: "error", text: t("character:validation.nameRequired") });
      return;
    }

    setSaving(true);
    setSaveMessage(null);

    try {
      const response = await authFetch("/api/character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(characterData),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSaveMessage({ type: "success", text: t("character:form.success") });

        if (onCharacterCreated && data.characterId) {
          onCharacterCreated(data.characterId);
        }
      } else {
        setSaveMessage({
          type: "error",
          text: `${t("character:form.failed")}: ${
            data.error || t("common:error.generic")
          }`,
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
