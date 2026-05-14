# I18N Quick Reference Card

## 🚀 Quick Start (3 Steps)

### Step 1: Import
```tsx
import { useTranslation } from 'react-i18next';
```

### Step 2: Initialize Hook
```tsx
const { t } = useTranslation('namespace'); // namespace: common, auth, home, game, character, checkpoint, module
```

### Step 3: Use Translations
```tsx
<button>{t('button.save')}</button>
```

---

## 📖 Common Patterns

### Basic Translation
```tsx
{t('key.path')}
```

### With Variables
```tsx
{t('welcome.message', { userName: 'John' })}
// Translation: "Welcome back, {{userName}}!"
```

### Pluralization
```tsx
{t('items.count', { count: itemCount })}
// Translation EN: "{{count}} item" / "{{count}} items"
// Translation ZH: "{{count}}个物品"
```

### Multiple Namespaces
```tsx
const { t } = useTranslation(['game', 'common']);
<button>{t('common:button.save')}</button>
<p>{t('game:session.playingAs')}</p>
```

### Nested Keys
```tsx
{t('character.attributes.STR')}
// From: { "character": { "attributes": { "STR": "Strength" } } }
```

---

## 🎯 Namespace Guide

| Namespace | Use For | Examples |
|-----------|---------|----------|
| `common` | Buttons, errors, validation, loading states | `button.save`, `error.network`, `loading.pleaseWait` |
| `auth` | Login, register, password reset, verification | `login.title`, `register.submit`, `forgotPassword.description` |
| `home` | Home page, menu, character list, settings | `menu.newGame`, `characters.title`, `settings.language` |
| `game` | Game chat, sessions, dice, clues, time | `session.playingAs`, `input.placeholder`, `dice.success` |
| `character` | Character creation, sheets, skills, attributes | `form.title`, `attributes.STR`, `skills.occupational` |
| `checkpoint` | Save/load system, checkpoint management | `title`, `save`, `load`, `success.created` |
| `module` | Module management, upload, selection | `title`, `upload`, `loading`, `success.uploaded` |

---

## 🔑 Key Naming Conventions

### Use dot notation for hierarchy
```json
{
  "button": {
    "save": "Save",
    "cancel": "Cancel"
  }
}
```

### Use descriptive names
```
✅ login.invalidCredentials
❌ login.error1

✅ character.validation.nameRequired
❌ character.err1
```

### Group related keys
```json
{
  "checkpoint": {
    "success": {
      "created": "Checkpoint created",
      "loaded": "Checkpoint loaded"
    },
    "errors": {
      "notFound": "Checkpoint not found"
    }
  }
}
```

---

## 🎨 Special Cases

### Skill Translation
```tsx
import { useSkillTranslation } from '../hooks/useSkillTranslation';

const { translateSkill } = useSkillTranslation();
<span>{translateSkill('Persuade')}</span>
// EN: "Persuade"
// ZH: "说服"
```

### Conditional Translation
```tsx
{isLoading ? t('common:loading.loading') : t('game:session.playingAs')}
```

### Array Map with Translation
```tsx
{menuItems.map(item => (
  <MenuItem key={item.key}>
    {t(`menu.${item.key}`)}
  </MenuItem>
))}
```

### Backend Message Translation
```tsx
// Backend sends:
{ messageKey: 'checkpoint.success.created', messageParams: { name: 'Save 1' } }

// Frontend translates:
const { t } = useTranslation('checkpoint');
const message = t(response.messageKey, response.messageParams);
```

---

## 📋 Translation File Template

### Adding New Keys

**File:** `client/src/i18n/locales/en/[namespace].json`
```json
{
  "newFeature": {
    "title": "Feature Title",
    "description": "Description with {{variable}}",
    "button": "Action Button",
    "success": "Success message",
    "error": "Error message"
  }
}
```

**File:** `client/src/i18n/locales/zh/[namespace].json`
```json
{
  "newFeature": {
    "title": "功能标题",
    "description": "带有{{variable}}的描述",
    "button": "操作按钮",
    "success": "成功消息",
    "error": "错误消息"
  }
}
```

---

## 🧪 Testing Checklist

After migrating a component:

- [ ] No hardcoded English strings remain
- [ ] All keys exist in both `en` and `zh` files
- [ ] Test in English - all text displays correctly
- [ ] Switch to Chinese - all text updates immediately
- [ ] No console warnings about missing keys
- [ ] Layout doesn't break with different text lengths
- [ ] Variables interpolate correctly
- [ ] Plurals work for both languages
- [ ] Build succeeds with no errors

---

## ⚡ Quick Commands

### Build and Check
```bash
cd client && pnpm build
```

### Check for Missing Keys (future script)
```bash
pnpm run check:translations
```

### Extract Translation Keys (future script)
```bash
pnpm run extract:i18n
```

---

## 🐛 Common Mistakes

### ❌ Don't hardcode strings
```tsx
<button>Save</button>
```

### ✅ Do use translations
```tsx
<button>{t('common:button.save')}</button>
```

---

### ❌ Don't forget both language files
```json
// Only added to en/common.json
{ "newKey": "New Text" }
```

### ✅ Do add to both EN and ZH
```json
// en/common.json
{ "newKey": "New Text" }

// zh/common.json
{ "newKey": "新文本" }
```

---

### ❌ Don't use nested t() calls
```tsx
{t(someCondition ? 'key1' : 'key2')} // Wrong!
```

### ✅ Do use ternary outside t()
```tsx
{someCondition ? t('key1') : t('key2')}
```

---

### ❌ Don't interpolate JSX
```tsx
{t('message', { link: <a href="#">Click</a> })} // Won't work!
```

### ✅ Do split into parts
```tsx
{t('message.before')} <a href="#">{t('message.linkText')}</a> {t('message.after')}
```

---

## 🔍 Debugging

### Missing Translation Warning
```
i18next::translator: missingKey en common button.unknown
```
**Solution:** Add the key to `en/common.json` and `zh/common.json`

### Variable Not Showing
```tsx
{t('welcome', { userName })} // Blank where userName should be
```
**Check:** Translation file has `{{userName}}` (double curly braces)

### Language Not Switching
**Check:**
1. `i18n.changeLanguage()` being called?
2. AppSettingsContext syncing correctly?
3. Browser console for errors?

---

## 📚 Quick Links

- **Migration Guide:** `I18N_MIGRATION_GUIDE.md`
- **Example Migration:** `MIGRATION_EXAMPLE.md`
- **Implementation Status:** `I18N_IMPLEMENTATION_SUMMARY.md`
- **Translation Files:** `client/src/i18n/locales/`
- **react-i18next Docs:** https://react.i18next.com/

---

## 💡 Pro Tips

1. **Use default namespace:** Import most common namespace as default to avoid prefixes
   ```tsx
   const { t } = useTranslation('common');
   {t('button.save')} // No prefix needed
   ```

2. **Extract repeated patterns:** If translating same pattern 10+ times, consider a helper
   ```tsx
   const tButton = (key: string) => t(`button.${key}`);
   <button>{tButton('save')}</button>
   ```

3. **Keep keys organized:** Group by feature, not by component
   ```json
   {
     "authentication": { ... },
     "navigation": { ... },
     "forms": { ... }
   }
   ```

4. **Test early, test often:** Switch languages frequently during development

5. **Use TypeScript:** Add type definitions for autocomplete (advanced)

---

## 🎯 Migration Workflow

```
┌─────────────────────────────────────┐
│ 1. Read component source            │
│ 2. Identify hardcoded strings       │
│ 3. Import useTranslation            │
│ 4. Initialize hook                  │
│ 5. Replace strings with t() calls   │
│ 6. Add keys to EN translation file  │
│ 7. Add keys to ZH translation file  │
│ 8. Test in both languages           │
│ 9. Fix any issues                   │
│ 10. Build & verify                  │
│ 11. Commit changes                  │
└─────────────────────────────────────┘
```

**Average time per component:** 15-30 minutes
**Total components to migrate:** ~30
**Estimated total time:** 2-3 weeks

---

**Print this and keep it handy while migrating components! 📌**
