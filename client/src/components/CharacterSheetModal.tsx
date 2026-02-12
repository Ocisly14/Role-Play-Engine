/**
 * CharacterSheetModal Component - Display full character sheet in read-only mode
 *
 * Shows complete character information similar to the character creation page.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { authFetch } from "../utils/authFetch";
import "./CharacterSheetModal.css";

interface CharacterSheetModalProps {
  sessionId?: string;
  characterId?: string;
  apiBaseUrl?: string;
  onClose: () => void;
}

interface CharacterData {
  name: string;
  occupation?: string;
  age?: number;
  gender?: string;
  era?: string;
  residence?: string;
  birthplace?: string;
  STR?: number;
  CON?: number;
  DEX?: number;
  APP?: number;
  POW?: number;
  SIZ?: number;
  INT?: number;
  EDU?: number;
  LCK?: number;
  HP?: number;
  maxHP?: number;
  SAN?: number;
  maxSAN?: number;
  MP?: number;
  maxMP?: number;
  LUCK?: number;
  MOV?: number;
  BUILD?: string;
  DB?: string;
  ARMOR?: string;
  skills?: Record<string, number>;
  weapons?: Array<{
    name: string;
    skill: string;
    damage: string;
    range: string;
    attacks: string;
    ammo: string;
  }>;
  appearance?: string;
  ideology?: string;
  people?: string;
  gear?: string;
  backstory?: string;
}

export function CharacterSheetModal({
  sessionId,
  characterId,
  apiBaseUrl = "/api",
  onClose,
}: CharacterSheetModalProps) {
  const { t } = useTranslation('character');
  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCharacterData = async () => {
      try {
        let response, data;

        // If characterId is provided, fetch character directly
        if (characterId) {
          response = await authFetch(`${apiBaseUrl}/character/${characterId}`);
          data = await response.json();

          if (data.success && data.character) {
            // Map database character to CharacterData format
            const char: any = data.character;
            console.log("Raw character data from API:", char);
            console.log("Occupation from API:", char.occupation);
            console.log("Skills data:", char.skills);
            console.log("Weapons data:", char.weapons);
            console.log("Notes data:", char.notes);

            const characterData: CharacterData = {
              name: char.name || "",
              occupation: char.occupation || undefined,
              age: char.age || undefined,
              gender: char.gender || char.notes?.gender || undefined,
              era: char.notes?.era || undefined,
              residence: char.notes?.residence || undefined,
              birthplace: char.notes?.birthplace || undefined,
              STR: char.attributes?.STR || undefined,
              CON: char.attributes?.CON || undefined,
              DEX: char.attributes?.DEX || undefined,
              APP: char.attributes?.APP || undefined,
              POW: char.attributes?.POW || undefined,
              SIZ: char.attributes?.SIZ || undefined,
              INT: char.attributes?.INT || undefined,
              EDU: char.attributes?.EDU || undefined,
              LCK: char.attributes?.LCK || undefined,
              // HP, SAN, MP etc are in status field, not derived
              HP: char.status?.hp || undefined,
              maxHP: char.status?.maxHp || undefined,
              SAN: char.status?.sanity || undefined,
              maxSAN: char.status?.maxSanity || undefined,
              MP: char.status?.mp || undefined,
              maxMP: char.status?.mp || undefined,
              LUCK: char.status?.luck || undefined,
              // MOV, BUILD, DB, ARMOR are in status or derived
              MOV: char.status?.mov || char.derived?.MOV || undefined,
              BUILD: char.status?.build || char.derived?.BUILD || undefined,
              DB: char.status?.damageBonus || char.derived?.DB || undefined,
              ARMOR: char.derived?.ARMOR || undefined,
              skills: char.skills || undefined,
              weapons: char.weapons || undefined,
              appearance: char.notes?.appearance || undefined,
              ideology: char.notes?.ideology || undefined,
              people: char.notes?.people || undefined,
              gear: char.notes?.gear || undefined,
              backstory: char.notes?.backstory || undefined,
            };

            console.log("Mapped characterData:", characterData);
            console.log("Mapped occupation:", characterData.occupation);
            console.log("Mapped skills:", characterData.skills);
            console.log("Mapped weapons:", characterData.weapons);

            setCharacter(characterData);
            setError(null);
          } else {
            throw new Error("Failed to load character data");
          }
        } else {
          // Original sessionId-based fetch
          response = await authFetch(`${apiBaseUrl}/gamestate`);
          data = await response.json();

          if (
            data.success &&
            data.gameState &&
            data.gameState.playerCharacter
          ) {
            // Map gameState.playerCharacter to our CharacterData format
            const playerChar = data.gameState.playerCharacter;
            const characterData: CharacterData = {
              name: playerChar.name || "",
              occupation: playerChar.occupation || undefined,
              age: playerChar.age || undefined,
              gender: playerChar.gender || undefined,
              era: playerChar.era || undefined,
              residence: playerChar.residence || undefined,
              birthplace: playerChar.birthplace || undefined,
              STR: playerChar.attributes?.STR || undefined,
              CON: playerChar.attributes?.CON || undefined,
              DEX: playerChar.attributes?.DEX || undefined,
              APP: playerChar.attributes?.APP || undefined,
              POW: playerChar.attributes?.POW || undefined,
              SIZ: playerChar.attributes?.SIZ || undefined,
              INT: playerChar.attributes?.INT || undefined,
              EDU: playerChar.attributes?.EDU || undefined,
              LCK: playerChar.attributes?.LCK || undefined,
              HP: playerChar.status?.hp || undefined,
              maxHP: playerChar.status?.maxHp || undefined,
              SAN: playerChar.status?.sanity || undefined,
              maxSAN: playerChar.status?.maxSanity || undefined,
              MP: playerChar.status?.mp || undefined,
              maxMP: playerChar.status?.mp || undefined, // MP doesn't have a separate max, usually same as current
              LUCK: playerChar.status?.luck || undefined,
              MOV: playerChar.derivedAttributes?.MOV || undefined,
              BUILD: playerChar.derivedAttributes?.BUILD || undefined,
              DB: playerChar.derivedAttributes?.DB || undefined,
              ARMOR: playerChar.derivedAttributes?.ARMOR || undefined,
              skills: playerChar.skills || {},
              weapons: playerChar.weapons || [],
              appearance: playerChar.appearance || undefined,
              ideology: playerChar.ideology || undefined,
              people: playerChar.significantPeople || undefined,
              gear: playerChar.gear || undefined,
              backstory: playerChar.backstory || undefined,
            };
            setCharacter(characterData);
            setError(null);
          } else {
            throw new Error("No character data found in game state");
          }
        }
      } catch (err) {
        console.error("Error fetching character:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchCharacterData();
  }, [apiBaseUrl, sessionId, characterId]);

  // Handle click on backdrop to close modal
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Determine what to render
  let modalContent: React.ReactNode = null;

  if (loading) {
    modalContent = (
      <div className="character-modal-backdrop" onClick={handleBackdropClick}>
        <div className="character-modal-content">
          <p style={{ textAlign: "center", padding: "40px" }}>
            {t('sheet.loading')}
          </p>
        </div>
      </div>
    );
  } else if (error || !character) {
    modalContent = (
      <div className="character-modal-backdrop" onClick={handleBackdropClick}>
        <div className="character-modal-content">
          <button className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
          <p style={{ textAlign: "center", padding: "40px", color: "#c41e3a" }}>
            {t('sheet.loadError')}: {error}
          </p>
        </div>
      </div>
    );
  } else if (character) {
    modalContent = (
      <div className="character-modal-backdrop" onClick={handleBackdropClick}>
        <div className="character-modal-content">
          <button className="modal-close-btn" onClick={onClose}>
            ✕
          </button>

          <div className="character-sheet-view">
            <h1>{t('sheet.title')} - {character.name}</h1>

            {/* Identity Section */}
            <div className="section-title">{t('identity.title')}</div>
            <table>
              <tbody>
                <tr>
                  <th>{t('identity.era')}</th>
                  <td>{character.era || "-"}</td>
                  <th>{t('identity.name')}</th>
                  <td>{character.name || "-"}</td>
                  <th>{t('identity.occupation')}</th>
                  <td>{character.occupation || "-"}</td>
                </tr>
                <tr>
                  <th>{t('identity.age')}</th>
                  <td>{character.age || "-"}</td>
                  <th>{t('identity.gender')}</th>
                  <td>{character.gender || "-"}</td>
                  <th>{t('identity.residence')}</th>
                  <td>{character.residence || "-"}</td>
                </tr>
                <tr>
                  <th>{t('identity.birthplace')}</th>
                  <td colSpan={5}>{character.birthplace || "-"}</td>
                </tr>
              </tbody>
            </table>

            {/* Attributes Section */}
            <div className="section-title">{t('attributes.title')}</div>
            <table>
              <tbody>
                <tr>
                  <th>STR</th>
                  <th>CON</th>
                  <th>DEX</th>
                  <th>APP</th>
                  <th>POW</th>
                  <th>SIZ</th>
                  <th>INT</th>
                  <th>EDU</th>
                  <th>LCK</th>
                </tr>
                <tr>
                  <td>{character.STR || "-"}</td>
                  <td>{character.CON || "-"}</td>
                  <td>{character.DEX || "-"}</td>
                  <td>{character.APP || "-"}</td>
                  <td>{character.POW || "-"}</td>
                  <td>{character.SIZ || "-"}</td>
                  <td>{character.INT || "-"}</td>
                  <td>{character.EDU || "-"}</td>
                  <td>{character.LCK || "-"}</td>
                </tr>
              </tbody>
            </table>

            {/* Derived Attributes */}
            <table>
              <tbody>
                <tr>
                  <th>{t('attributes.HP')}</th>
                  <td>
                    {character.HP !== undefined && character.maxHP !== undefined
                      ? `${character.HP}/${character.maxHP}`
                      : "-"}
                  </td>
                  <th>{t('attributes.SAN')}</th>
                  <td>
                    {character.SAN !== undefined &&
                    character.maxSAN !== undefined
                      ? `${character.SAN}/${character.maxSAN}`
                      : "-"}
                  </td>
                  <th>{t('attributes.MP')}</th>
                  <td>
                    {character.MP !== undefined && character.maxMP !== undefined
                      ? `${character.MP}/${character.maxMP}`
                      : "-"}
                  </td>
                  <th>{t('attributes.LUCK')}</th>
                  <td>{character.LUCK || "-"}</td>
                </tr>
                <tr>
                  <th>{t('attributes.MOV')}</th>
                  <td>{character.MOV || "-"}</td>
                  <th>{t('attributes.BUILD')}</th>
                  <td>{character.BUILD || "-"}</td>
                  <th>{t('attributes.DB')}</th>
                  <td>{character.DB || "-"}</td>
                  <th>{t('attributes.ARMOR')}</th>
                  <td>{character.ARMOR || "-"}</td>
                </tr>
              </tbody>
            </table>

            {/* Skills Section */}
            <div className="section-title">{t('skills.title')}</div>
            {character.skills && Object.keys(character.skills).length > 0 ? (
              <div className="skills-display-grid">
                {Object.entries(character.skills)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([skillName, skillValue]) => (
                    <div key={skillName} className="skill-display-item">
                      <span className="skill-display-name">{skillName}</span>
                      <span className="skill-display-value">{skillValue}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <p style={{ color: "#999", fontStyle: "italic" }}>
                {t('sheet.noSkills')}
              </p>
            )}

            {/* Weapons Section */}
            <div className="section-title">{t('weapons.title')}</div>
            {character.weapons && character.weapons.length > 0 ? (
              <table>
                <tbody>
                  <tr>
                    <th>{t('weapons.weaponHeader')}</th>
                    <th>{t('weapons.skillHeader')}</th>
                    <th>{t('weapons.damage')}</th>
                    <th>{t('weapons.range')}</th>
                    <th>{t('weapons.attacksHeader')}</th>
                    <th>{t('weapons.ammo')}</th>
                  </tr>
                  {character.weapons.map((weapon, idx) => (
                    <tr key={idx}>
                      <td>{weapon.name || "-"}</td>
                      <td>{weapon.skill || "-"}</td>
                      <td>{weapon.damage || "-"}</td>
                      <td>{weapon.range || "-"}</td>
                      <td>{weapon.attacks || "-"}</td>
                      <td>{weapon.ammo || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: "#999", fontStyle: "italic" }}>
                {t('sheet.noWeapons')}
              </p>
            )}

            {/* Portrait & Notes Section */}
            <div className="section-title">{t('notes.title')}</div>
            <div className="notes-display-grid">
              <div className="note-section">
                <h4>{t('notes.appearance')}</h4>
                <p>{character.appearance || t('sheet.notProvided')}</p>
              </div>
              <div className="note-section">
                <h4>{t('notes.ideology')}</h4>
                <p>{character.ideology || t('sheet.notProvided')}</p>
              </div>
              <div className="note-section">
                <h4>{t('notes.people')}</h4>
                <p>{character.people || t('sheet.notProvided')}</p>
              </div>
              <div className="note-section">
                <h4>{t('notes.gear')}</h4>
                <p>{character.gear || t('sheet.notProvided')}</p>
              </div>
            </div>

            {/* Background Story */}
            <div className="section-title">{t('notes.backstory')}</div>
            <div className="note-section">
              <p>{character.backstory || t('sheet.notProvided')}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Render modal using Portal to body for full-screen overlay
  return typeof document !== "undefined" && modalContent
    ? createPortal(modalContent, document.body)
    : null;
}
