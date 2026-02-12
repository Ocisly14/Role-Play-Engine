# I18N Migration Guide

## ✅ Completed Infrastructure

### Phase 1: Core Setup (DONE)

1. **Dependencies Installed**
   - `i18next` (v25.8.5)
   - `react-i18next` (v16.5.4)
   - `i18next-browser-languagedetector` (v8.2.0)
   - Bundle size impact: ~56KB (acceptable)

2. **Translation Files Created**
   - ✅ `client/src/i18n/locales/en/*.json` (7 namespaces)
   - ✅ `client/src/i18n/locales/zh/*.json` (7 namespaces)
   - Namespaces: `common`, `auth`, `home`, `game`, `character`, `checkpoint`, `module`

3. **Core Files**
   - ✅ `client/src/i18n/config.ts` - i18next configuration
   - ✅ `client/src/i18n/index.ts` - Export module
   - ✅ `client/src/main.tsx` - Initialized i18n
   - ✅ `client/src/contexts/AppSettingsContext.tsx` - Synced with i18next
   - ✅ `client/src/hooks/useSkillTranslation.ts` - Skill translation hook
   - ✅ `client/server/utils/i18nKeys.ts` - Backend message keys

## 📋 Next Steps: Component Migration

### Week 1-2: Authentication & Home Pages

#### Priority 1: Authentication Components
- [ ] `client/src/components/auth/LoginForm.tsx`
- [ ] `client/src/components/auth/RegisterForm.tsx`
- [ ] `client/src/components/auth/ForgotPasswordForm.tsx`
- [ ] `client/src/components/auth/ResetPasswordForm.tsx`
- [ ] `client/src/components/auth/VerifyEmailForm.tsx`

#### Priority 2: Home & Navigation
- [ ] `client/src/views/HomePage.tsx`
- [ ] `client/src/views/Homes.tsx`
- [ ] `client/src/components/CharacterSelector.tsx`
- [ ] `client/src/components/modals/CharacterSheetModal.tsx`

### Week 2-3: Game Interface

#### Priority 3: Game Chat
- [ ] `client/src/components/GameChat.tsx`
- [ ] `client/src/components/gamechat/InputArea.tsx`
- [ ] `client/src/components/gamechat/SessionInfoBar.tsx`
- [ ] `client/src/components/gamechat/SkillSelectionModal.tsx`
- [ ] `client/src/components/gamechat/MessageItem.tsx`

#### Priority 4: Character Management
- [ ] `client/src/views/CharacterCreationPage.tsx`
- [ ] `client/src/components/character/CharacterForm.tsx`
- [ ] `client/src/components/character/IdentitySection.tsx`
- [ ] `client/src/components/character/AttributesSection.tsx`
- [ ] `client/src/components/character/SkillsSection.tsx`
- [ ] `client/src/components/character/WeaponsSection.tsx`

### Week 3-4: Modules & Checkpoints

#### Priority 5: Module Management
- [ ] `client/src/components/ModSelector.tsx`
- [ ] `client/src/components/ModManager.tsx`
- [ ] `client/src/components/ModLoadingModal.tsx`

#### Priority 6: Checkpoint System
- [ ] `client/src/components/modals/CheckpointSelectorModal.tsx`
- [ ] `client/src/components/checkpoint/CheckpointCard.tsx`

#### Priority 7: Backend Controllers
- [ ] `client/server/auth/controller.ts`
- [ ] `client/server/game/controller.ts`
- [ ] `client/server/character/controller.ts`
- [ ] `client/server/checkpoint/controller.ts`
- [ ] `client/server/mod/controller.ts`

---

## 📖 Migration Examples

### Example 1: Simple Button Migration

**Before:**
```tsx
<button onClick={handleSave}>Save</button>
```

**After:**
```tsx
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation('common');

  return <button onClick={handleSave}>{t('button.save')}</button>;
}
```

### Example 2: Form with Validation

**Before:**
```tsx
<div className="form-group">
  <label htmlFor="email">Email</label>
  <input id="email" type="email" placeholder="Enter your email" />
  {error && <span className="error">Invalid email address</span>}
</div>
```

**After:**
```tsx
import { useTranslation } from 'react-i18next';

function LoginForm() {
  const { t } = useTranslation('auth');

  return (
    <div className="form-group">
      <label htmlFor="email">{t('login.email')}</label>
      <input id="email" type="email" placeholder={t('login.emailPlaceholder')} />
      {error && <span className="error">{t('validation.emailInvalid')}</span>}
    </div>
  );
}
```

### Example 3: Dynamic Messages with Variables

**Before:**
```tsx
<p>Welcome back, {userName}!</p>
<p>{count} items found</p>
```

**After:**
```tsx
import { useTranslation } from 'react-i18next';

function Dashboard() {
  const { t } = useTranslation('home');

  return (
    <>
      <p>{t('welcome.message', { userName })}</p>
      <p>{t('search.results', { count })}</p>
    </>
  );
}
```

Translation files need:
```json
{
  "welcome": {
    "message": "Welcome back, {{userName}}!"
  },
  "search": {
    "results": "{{count}} item found",
    "results_plural": "{{count}} items found"
  }
}
```

### Example 4: Skill Translation (Using Custom Hook)

**Before:**
```tsx
import { getSkillNameZh } from '../lib/skillNames';

function SkillList({ skills }: { skills: string[] }) {
  const { language } = useAppSettings();

  return (
    <ul>
      {skills.map(skill => (
        <li key={skill}>
          {language === 'zh' ? getSkillNameZh(skill) : skill}
        </li>
      ))}
    </ul>
  );
}
```

**After:**
```tsx
import { useSkillTranslation } from '../hooks/useSkillTranslation';

function SkillList({ skills }: { skills: string[] }) {
  const { translateSkill } = useSkillTranslation();

  return (
    <ul>
      {skills.map(skill => (
        <li key={skill}>{translateSkill(skill)}</li>
      ))}
    </ul>
  );
}
```

### Example 5: Backend Response with i18n

**Backend (Controller):**
```typescript
import { I18N_KEYS } from '../utils/i18nKeys.js';

export async function saveCheckpoint(req, res) {
  try {
    const checkpoint = await createCheckpoint(req.params.sessionId);

    res.json({
      success: true,
      messageKey: I18N_KEYS.CHECKPOINT_SAVED,
      data: checkpoint,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      messageKey: I18N_KEYS.CHECKPOINT_CREATE_FAILED,
      error: error.message,
    });
  }
}
```

**Frontend (Component):**
```typescript
import { useTranslation } from 'react-i18next';

function CheckpointManager() {
  const { t } = useTranslation('checkpoint');

  const handleSave = async () => {
    const response = await fetch('/api/checkpoints/save', { method: 'POST' });
    const data = await response.json();

    if (data.messageKey) {
      const message = t(data.messageKey, data.messageParams);
      showNotification(message, data.success ? 'success' : 'error');
    }
  };

  return <button onClick={handleSave}>{t('save')}</button>;
}
```

### Example 6: Conditional Rendering with Translation

**Before:**
```tsx
{isLoading ? 'Loading...' : characters.length === 0
  ? 'No characters found'
  : `${characters.length} characters`}
```

**After:**
```tsx
const { t } = useTranslation('home');

{isLoading ? t('characters.loading') : characters.length === 0
  ? t('characters.empty')
  : t('characters.count', { count: characters.length })}
```

---

## 🔧 Common Patterns

### 1. Multiple Namespaces in One Component

```tsx
import { useTranslation } from 'react-i18next';

function ComplexComponent() {
  const { t } = useTranslation(['game', 'common']);

  return (
    <>
      <button>{t('common:button.save')}</button>
      <p>{t('game:session.playingAs')}: {characterName}</p>
    </>
  );
}
```

### 2. Pluralization

English and Chinese use the same pattern:
```json
{
  "items": "{{count}} item",
  "items_plural": "{{count}} items"
}
```

Usage:
```tsx
{t('items', { count: itemCount })}
```

### 3. Nested Objects

Translation file:
```json
{
  "character": {
    "attributes": {
      "STR": "Strength",
      "DEX": "Dexterity"
    }
  }
}
```

Usage:
```tsx
{t('character.attributes.STR')}
```

### 4. Fallback to Key

If a translation key is missing, i18next will show the key itself:
- Development: Shows key + warning in console
- Production: Shows key (graceful degradation)

---

## ✅ Testing Checklist

### Per Component Migration:

- [ ] All hardcoded strings replaced with `t()` calls
- [ ] Translation keys exist in both `en` and `zh` files
- [ ] Variables properly interpolated with `{{variable}}`
- [ ] Plurals work correctly for both languages
- [ ] Language switch updates UI immediately (no page refresh needed)
- [ ] No console warnings about missing keys
- [ ] Layout doesn't break with longer text (Chinese is usually shorter)

### Full Application Testing:

- [ ] Login/Register flow (EN + ZH)
- [ ] Character creation (EN + ZH)
- [ ] Game session (EN + ZH)
- [ ] Skill selection (verify skill names translate)
- [ ] Checkpoint save/load (EN + ZH)
- [ ] Module management (EN + ZH)
- [ ] Error messages display correctly
- [ ] Backend messages translate properly
- [ ] Language persists across page refreshes
- [ ] Language syncs with backend session

---

## 🚀 Quick Start for Developers

### 1. Import the hook
```tsx
import { useTranslation } from 'react-i18next';
```

### 2. Use in component
```tsx
const { t } = useTranslation('namespace');
```

### 3. Replace strings
```tsx
{t('key.path')}
{t('key.withVariable', { name: userName })}
```

### 4. Add translations
Update both:
- `client/src/i18n/locales/en/[namespace].json`
- `client/src/i18n/locales/zh/[namespace].json`

---

## 📚 Resources

- **react-i18next Docs**: https://react.i18next.com/
- **i18next Docs**: https://www.i18next.com/
- **Translation Management**: All JSON files in `client/src/i18n/locales/`
- **Skill Translations**: Use `useSkillTranslation()` hook

---

## 🎯 Success Metrics

- [x] i18n infrastructure set up
- [x] All translation files created (14 files total)
- [x] Build succeeds with no errors
- [x] Bundle size increase < 100KB (✓ 56KB)
- [ ] All UI components migrated
- [ ] All backend messages using i18n keys
- [ ] Complete E2E testing in both languages
- [ ] Zero missing translation warnings
