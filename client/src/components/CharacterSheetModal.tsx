/**
 * CharacterSheetModal Component - Display full character sheet in read-only mode
 *
 * Shows complete character information similar to the character creation page.
 */

import { useEffect, useState } from 'react';
import './CharacterSheetModal.css';

interface CharacterSheetModalProps {
  sessionId: string;
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

export function CharacterSheetModal({ sessionId, apiBaseUrl = 'http://localhost:3000/api', onClose }: CharacterSheetModalProps) {
  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCharacterData = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/gamestate`);
        const data = await response.json();

        if (data.success && data.gameState && data.gameState.playerCharacter) {
          // Map gameState.playerCharacter to our CharacterData format
          const playerChar = data.gameState.playerCharacter;
          const characterData: CharacterData = {
            name: playerChar.name || '',
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
        } else {
          throw new Error('No character data found in game state');
        }
      } catch (err) {
        console.error('Error fetching character:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchCharacterData();
  }, [apiBaseUrl, sessionId]);

  // Handle click on backdrop to close modal
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (loading) {
    return (
      <div className="character-modal-backdrop" onClick={handleBackdropClick}>
        <div className="character-modal-content">
          <p style={{ textAlign: 'center', padding: '40px' }}>Loading character data...</p>
        </div>
      </div>
    );
  }

  if (error || !character) {
    return (
      <div className="character-modal-backdrop" onClick={handleBackdropClick}>
        <div className="character-modal-content">
          <button className="modal-close-btn" onClick={onClose}>✕</button>
          <p style={{ textAlign: 'center', padding: '40px', color: '#c41e3a' }}>
            Failed to load character data: {error}
          </p>
        </div>
      </div>
    );
  }

  // Organize skills by category (simple categorization based on common CoC skills)
  const skillCategories = {
    social: ['Charm', 'Fast Talk', 'Intimidate', 'Persuade', 'Psychology'],
    knowledge: ['Accounting', 'Anthropology', 'Appraise', 'Archaeology', 'History', 'Library Use', 'Natural World', 'Occult', 'Science'],
    investigation: ['Law', 'Spot Hidden', 'Listen'],
    physical: ['Climb', 'Dodge', 'Jump', 'Ride', 'Swim'],
    stealth: ['Locksmith', 'Sleight of Hand', 'Stealth'],
    technical: ['Art/Craft', 'Computer Use', 'Disguise', 'Drive Auto', 'Electrical Repair', 'Mechanical Repair', 'Navigate', 'Operate Heavy Machinery', 'Pilot'],
    medical: ['First Aid', 'Medicine', 'Pharmacy', 'Psychoanalysis'],
    combat: ['Brawl', 'Firearms', 'Handgun', 'Rifle', 'Shotgun', 'Submachine Gun', 'Fighting'],
    criminal: ['Credit Rating', 'Locksmith', 'Track'],
    language: ['Language (Own)', 'Language (Other)'],
    special: ['Cthulhu Mythos', 'Status']
  };

  return (
    <div className="character-modal-backdrop" onClick={handleBackdropClick}>
      <div className="character-modal-content">
        <button className="modal-close-btn" onClick={onClose}>✕</button>

        <div className="character-sheet-view">
          <h1>Character Sheet - {character.name}</h1>

          {/* Identity Section */}
          <div className="section-title">Identity</div>
          <table>
            <tbody>
              <tr>
                <th>Era</th>
                <td>{character.era || '-'}</td>
                <th>Name</th>
                <td>{character.name || '-'}</td>
                <th>Occupation</th>
                <td>{character.occupation || '-'}</td>
              </tr>
              <tr>
                <th>Age</th>
                <td>{character.age || '-'}</td>
                <th>Gender</th>
                <td>{character.gender || '-'}</td>
                <th>Residence</th>
                <td>{character.residence || '-'}</td>
              </tr>
              <tr>
                <th>Birthplace</th>
                <td colSpan={5}>{character.birthplace || '-'}</td>
              </tr>
            </tbody>
          </table>

          {/* Attributes Section */}
          <div className="section-title">Attributes</div>
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
                <td>{character.STR || '-'}</td>
                <td>{character.CON || '-'}</td>
                <td>{character.DEX || '-'}</td>
                <td>{character.APP || '-'}</td>
                <td>{character.POW || '-'}</td>
                <td>{character.SIZ || '-'}</td>
                <td>{character.INT || '-'}</td>
                <td>{character.EDU || '-'}</td>
                <td>{character.LCK || '-'}</td>
              </tr>
            </tbody>
          </table>

          {/* Derived Attributes */}
          <table>
            <tbody>
              <tr>
                <th>HP</th>
                <td>
                  {character.HP !== undefined && character.maxHP !== undefined
                    ? `${character.HP}/${character.maxHP}`
                    : '-'}
                </td>
                <th>Sanity</th>
                <td>
                  {character.SAN !== undefined && character.maxSAN !== undefined
                    ? `${character.SAN}/${character.maxSAN}`
                    : '-'}
                </td>
                <th>MP</th>
                <td>
                  {character.MP !== undefined && character.maxMP !== undefined
                    ? `${character.MP}/${character.maxMP}`
                    : '-'}
                </td>
                <th>Luck</th>
                <td>{character.LUCK || '-'}</td>
              </tr>
              <tr>
                <th>Move</th>
                <td>{character.MOV || '-'}</td>
                <th>Build</th>
                <td>{character.BUILD || '-'}</td>
                <th>DB</th>
                <td>{character.DB || '-'}</td>
                <th>Armor</th>
                <td>{character.ARMOR || '-'}</td>
              </tr>
            </tbody>
          </table>

          {/* Skills Section */}
          <div className="section-title">Skills</div>
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
            <p style={{ color: '#999', fontStyle: 'italic' }}>No skills recorded</p>
          )}

          {/* Weapons Section */}
          <div className="section-title">Weapons</div>
          {character.weapons && character.weapons.length > 0 ? (
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
                {character.weapons.map((weapon, idx) => (
                  <tr key={idx}>
                    <td>{weapon.name || '-'}</td>
                    <td>{weapon.skill || '-'}</td>
                    <td>{weapon.damage || '-'}</td>
                    <td>{weapon.range || '-'}</td>
                    <td>{weapon.attacks || '-'}</td>
                    <td>{weapon.ammo || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: '#999', fontStyle: 'italic' }}>No weapons recorded</p>
          )}

          {/* Portrait & Notes Section */}
          <div className="section-title">Portrait & Notes</div>
          <div className="notes-display-grid">
            <div className="note-section">
              <h4>Appearance</h4>
              <p>{character.appearance || 'Not provided'}</p>
            </div>
            <div className="note-section">
              <h4>Traits / Ideology</h4>
              <p>{character.ideology || 'Not provided'}</p>
            </div>
            <div className="note-section">
              <h4>Significant People</h4>
              <p>{character.people || 'Not provided'}</p>
            </div>
            <div className="note-section">
              <h4>Gear & Assets</h4>
              <p>{character.gear || 'Not provided'}</p>
            </div>
          </div>

          {/* Background Story */}
          <div className="section-title">Background Story</div>
          <div className="note-section">
            <p>{character.backstory || 'Not provided'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
