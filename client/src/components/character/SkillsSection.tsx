import type React from "react";
import { useTranslation } from "react-i18next";
import { useSkillTranslation } from "../../hooks/useSkillTranslation";

interface Skill {
  name: string;
  base: string;
  category: string;
  occupationalValue: string;
  interestValue: string;
}

interface SkillsSectionProps {
  form: Record<string, string>;
  onChange: (key: string, value: string) => void;
  skillsState: Skill[];
  skillPointsUsage: {
    occupationalUsed: number;
    interestUsed: number;
    occupationalRemaining: number;
    interestRemaining: number;
  };
  selectedOccupation: any;
  occupationalPoints: number;
  interestPoints: number;
}

export const SkillsSection: React.FC<SkillsSectionProps> = ({
  form,
  onChange,
  skillsState,
  skillPointsUsage,
  selectedOccupation,
  occupationalPoints,
  interestPoints,
}) => {
  const { t } = useTranslation("character");
  const { translateSkill } = useSkillTranslation();

  const valueColumnStyle: React.CSSProperties = {
    width: "104px",
    minWidth: "104px",
    whiteSpace: "nowrap",
  };

  const totalColumnStyle: React.CSSProperties = {
    width: "88px",
    minWidth: "88px",
    whiteSpace: "nowrap",
  };

  return (
    <>
      <div className="section-title">{t("skills.title")}</div>

      {/* Skill Points Display */}
      <div
        style={{
          marginBottom: "16px",
          padding: "16px",
          background: "#fff9e6",
          border: "2px solid #8b7355",
          borderRadius: "4px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
        }}
      >
        <div>
          <strong style={{ color: "#8b7355", fontSize: "1rem" }}>
            {t("skills.occupational")}
          </strong>
          <div
            style={{
              fontSize: "1.5rem",
              fontWeight: "bold",
              color:
                skillPointsUsage.occupationalRemaining < 0
                  ? "#c41e3a"
                  : "#3d2817",
              marginTop: "4px",
            }}
          >
            {t("skills.remaining")} {skillPointsUsage.occupationalRemaining}
          </div>
          <div style={{ fontSize: "0.9rem", color: "#666", marginTop: "4px" }}>
            {t("skills.totalLabel")} {occupationalPoints} | {t("skills.used")}{" "}
            {skillPointsUsage.occupationalUsed}
          </div>
          {selectedOccupation &&
            selectedOccupation.suggested_occupational_points && (
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "#999",
                  marginTop: "2px",
                }}
              >
                ({selectedOccupation.suggested_occupational_points.expression})
              </div>
            )}
          {skillPointsUsage.occupationalRemaining < 0 && (
            <div
              style={{
                fontSize: "0.8rem",
                color: "#c41e3a",
                marginTop: "4px",
                fontWeight: "bold",
              }}
            >
              {t("skills.pointsExceeded")}
            </div>
          )}
        </div>
        <div>
          <strong style={{ color: "#8b7355", fontSize: "1rem" }}>
            {t("skills.interest")}
          </strong>
          <div
            style={{
              fontSize: "1.5rem",
              fontWeight: "bold",
              color:
                skillPointsUsage.interestRemaining < 0 ? "#c41e3a" : "#3d2817",
              marginTop: "4px",
            }}
          >
            {t("skills.remaining")} {skillPointsUsage.interestRemaining}
          </div>
          <div style={{ fontSize: "0.9rem", color: "#666", marginTop: "4px" }}>
            {t("skills.totalLabel")} {interestPoints} | {t("skills.used")}{" "}
            {skillPointsUsage.interestUsed}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "2px" }}>
            (INT × 2)
          </div>
          {skillPointsUsage.interestRemaining < 0 && (
            <div
              style={{
                fontSize: "0.8rem",
                color: "#c41e3a",
                marginTop: "4px",
                fontWeight: "bold",
              }}
            >
              {t("skills.pointsExceeded")}
            </div>
          )}
        </div>
      </div>

      {/* Tip */}
      <div
        style={{
          marginBottom: "16px",
          padding: "10px",
          background: "#e8f4f8",
          border: "1px solid #5ba3c0",
          borderRadius: "4px",
          fontSize: "0.85rem",
          color: "#2c5f75",
        }}
      >
        <strong>{t("skills.tip")}</strong> {t("skills.tipText")}
      </div>

      {/* Recommended Skills */}
      {selectedOccupation &&
        selectedOccupation.suggested_skills &&
        selectedOccupation.suggested_skills.length > 0 && (
          <div
            style={{
              marginBottom: "16px",
              padding: "12px",
              background: "#f0f8ff",
              border: "1px solid #8b7355",
              borderRadius: "4px",
            }}
          >
            <strong style={{ color: "#8b7355" }}>
              {t("skills.recommended", {
                occupation: selectedOccupation.name_en,
              })}
            </strong>
            <div
              style={{
                marginTop: "8px",
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              {selectedOccupation.suggested_skills.map(
                (skill: string, index: number) => (
                  <span
                    key={index}
                    style={{
                      padding: "4px 8px",
                      background: "#fff",
                      border: "1px solid #ddd",
                      borderRadius: "3px",
                      fontSize: "0.85rem",
                    }}
                  >
                    {translateSkill(skill)}
                  </span>
                )
              )}
            </div>
          </div>
        )}

      {/* Skills Grid - Two Columns */}
      <div className="skills-two-columns">
        {/* Left Column */}
        <div>
          {[
            {
              key: "social-knowledge",
              labelKey: "categories.socialKnowledge",
              categories: ["Social", "Knowledge", "Language"],
            },
            {
              key: "investigation",
              labelKey: "categories.investigationCriminal",
              categories: ["Investigation", "Criminal"],
            },
            {
              key: "combat",
              labelKey: "categories.combat",
              categories: ["Combat"],
            },
          ].map((group) => {
            const groupSkills = skillsState.filter((s) =>
              group.categories.includes(s.category)
            );
            if (groupSkills.length === 0) return null;

            return (
              <div
                key={group.key}
                className="skill-category"
                style={{ marginBottom: "20px" }}
              >
                <h4 className="skill-category-title">
                  {t(`skills.${group.labelKey}`)}
                </h4>
                <table className="skills-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>
                        {t("skills.skillName")}
                      </th>
                      <th style={valueColumnStyle}>
                        {t("skills.occupationalColumn")}
                      </th>
                      <th style={valueColumnStyle}>
                        {t("skills.interestColumn")}
                      </th>
                      <th style={totalColumnStyle}>{t("skills.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupSkills.map((skill) => {
                      const isOccupationalSkill =
                        selectedOccupation?.suggested_skills?.includes(
                          skill.name
                        );
                      const baseValue =
                        Number.parseInt(skill.base.replace("%", "")) || 0;
                      const occValue =
                        Number.parseInt(skill.occupationalValue) || 0;
                      const intValue =
                        Number.parseInt(skill.interestValue) || 0;
                      const totalValue = baseValue + occValue + intValue;

                      return (
                        <tr
                          key={skill.name}
                          style={{
                            backgroundColor: isOccupationalSkill
                              ? "#f5e6d3"
                              : "transparent",
                          }}
                        >
                          <td className="skill-name-cell">
                            <span>{translateSkill(skill.name)}</span>
                            <span
                              className="skill-base"
                              style={{ marginLeft: "8px", color: "#999" }}
                            >
                              ({skill.base})
                            </span>
                          </td>
                          <td
                            className="skill-value-cell"
                            style={valueColumnStyle}
                          >
                            <input
                              type="number"
                              min="0"
                              max="99"
                              placeholder="0"
                              value={skill.occupationalValue}
                              onChange={(e) =>
                                onChange(
                                  `skill_occ_${skill.name}`,
                                  e.target.value
                                )
                              }
                              style={{ width: "100%" }}
                            />
                          </td>
                          <td
                            className="skill-value-cell"
                            style={valueColumnStyle}
                          >
                            <input
                              type="number"
                              min="0"
                              max="99"
                              placeholder="0"
                              value={skill.interestValue}
                              onChange={(e) =>
                                onChange(
                                  `skill_int_${skill.name}`,
                                  e.target.value
                                )
                              }
                              style={{ width: "100%" }}
                            />
                          </td>
                          <td
                            className="skill-value-cell"
                            style={{
                              ...totalColumnStyle,
                              textAlign: "center",
                              fontWeight: "bold",
                              backgroundColor: "#f0f0f0",
                            }}
                          >
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
            {
              key: "physical",
              labelKey: "categories.physicalStealth",
              categories: ["Physical", "Stealth"],
            },
            {
              key: "technical-medical",
              labelKey: "categories.technicalMedical",
              categories: ["Technical", "Medical"],
            },
            {
              key: "special",
              labelKey: "categories.special",
              categories: ["Status", "Mythos"],
            },
          ].map((group) => {
            const groupSkills = skillsState.filter((s) =>
              group.categories.includes(s.category)
            );
            if (groupSkills.length === 0) return null;

            return (
              <div
                key={group.key}
                className="skill-category"
                style={{ marginBottom: "20px" }}
              >
                <h4 className="skill-category-title">
                  {t(`skills.${group.labelKey}`)}
                </h4>
                <table className="skills-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>
                        {t("skills.skillName")}
                      </th>
                      <th style={valueColumnStyle}>
                        {t("skills.occupationalColumn")}
                      </th>
                      <th style={valueColumnStyle}>
                        {t("skills.interestColumn")}
                      </th>
                      <th style={totalColumnStyle}>{t("skills.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupSkills.map((skill) => {
                      const isOccupationalSkill =
                        selectedOccupation?.suggested_skills?.includes(
                          skill.name
                        );
                      const baseValue =
                        Number.parseInt(skill.base.replace("%", "")) || 0;
                      const occValue =
                        Number.parseInt(skill.occupationalValue) || 0;
                      const intValue =
                        Number.parseInt(skill.interestValue) || 0;
                      const totalValue = baseValue + occValue + intValue;

                      return (
                        <tr
                          key={skill.name}
                          style={{
                            backgroundColor: isOccupationalSkill
                              ? "#f5e6d3"
                              : "transparent",
                          }}
                        >
                          <td className="skill-name-cell">
                            <span>{translateSkill(skill.name)}</span>
                            <span
                              className="skill-base"
                              style={{ marginLeft: "8px", color: "#999" }}
                            >
                              ({skill.base})
                            </span>
                          </td>
                          <td
                            className="skill-value-cell"
                            style={valueColumnStyle}
                          >
                            <input
                              type="number"
                              min="0"
                              max="99"
                              placeholder="0"
                              value={skill.occupationalValue}
                              onChange={(e) =>
                                onChange(
                                  `skill_occ_${skill.name}`,
                                  e.target.value
                                )
                              }
                              style={{ width: "100%" }}
                            />
                          </td>
                          <td
                            className="skill-value-cell"
                            style={valueColumnStyle}
                          >
                            <input
                              type="number"
                              min="0"
                              max="99"
                              placeholder="0"
                              value={skill.interestValue}
                              onChange={(e) =>
                                onChange(
                                  `skill_int_${skill.name}`,
                                  e.target.value
                                )
                              }
                              style={{ width: "100%" }}
                            />
                          </td>
                          <td
                            className="skill-value-cell"
                            style={{
                              ...totalColumnStyle,
                              textAlign: "center",
                              fontWeight: "bold",
                              backgroundColor: "#f0f0f0",
                            }}
                          >
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
    </>
  );
};
