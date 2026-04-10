/**
 * geocontext — UI Tree Builder
 *
 * Construit l'arborescence de navigation dynamique à partir du registre
 * et du contexte courant. Produit des UITreeNode pour :
 *
 *   - Le panneau latéral de l'interface web
 *   - Les enums/descriptions du tool `action` pour le LLM
 *   - Les resources MCP `geocontext://themes/{level}`
 *
 * L'arbre est reconstruit à chaque changement de contexte (navigate, action).
 * Les badges (compteurs) sont remplis paresseusement : null = pas chargé,
 * number = nombre d'éléments après requête.
 *
 * Structure de l'arbre :
 *
 *   Loray (25349)                    ← racine (territoire courant)
 *   ├── Identité                     ← thème
 *   │   └── IRIS                     ← action
 *   ├── Urbanisme                    ← thème
 *   │   ├── Document en vigueur      ← action
 *   │   ├── Zonages                  ← action
 *   │   ├── Prescriptions            ← action
 *   │   └── Servitudes               ← action
 *   └── ...
 *
 * @see docs/navigation-context.md — cycle de navigation
 */

import type { UITreeNode, UIIcon } from "./types.js";
import type { TerritoryLevel, Theme, NavigationContext } from "../types.js";
import { Registry } from "./registry.js";

// ==========================================================================
// Icônes et labels par thème
// ==========================================================================

/**
 * Métadonnées visuelles de chaque thème.
 * Utilisées pour l'affichage dans l'interface et les descriptions LLM.
 */
const THEME_META: Record<Theme, { label: string; icon: UIIcon; description: string }> = {
  identite: {
    label: "Identité",
    icon: "info",
    description: "Informations administratives, population, superficie",
  },
  urbanisme: {
    label: "Urbanisme",
    icon: "building",
    description: "Documents d'urbanisme, zonages, prescriptions, servitudes",
  },
  cadastre: {
    label: "Cadastre",
    icon: "map-pin",
    description: "Parcelles cadastrales, sections, feuilles",
  },
  risques: {
    label: "Risques",
    icon: "alert-triangle",
    description: "Risques naturels et technologiques, PPR, radon, CatNat",
  },
  environnement: {
    label: "Environnement",
    icon: "leaf",
    description: "ZNIEFF, Natura 2000, parcs naturels, réserves",
  },
  transport: {
    label: "Transport",
    icon: "truck",
    description: "Réseau routier, ferroviaire",
  },
  hydrologie: {
    label: "Hydrologie",
    icon: "droplets",
    description: "Cours d'eau, plans d'eau, qualité de l'eau",
  },
  economie: {
    label: "Économie",
    icon: "briefcase",
    description: "Entreprises, transactions immobilières",
  },
  bati: {
    label: "Bâti",
    icon: "home",
    description: "Bâtiments, emprise bâtie, identifiants RNB",
  },
  energie: {
    label: "Énergie",
    icon: "zap",
    description: "DPE, consommation, émissions GES, isolation",
  },
};

// ==========================================================================
// Construction de l'arbre
// ==========================================================================

/**
 * Construit l'arbre de navigation complet pour le contexte courant.
 *
 * @param ctx      — contexte de navigation
 * @param registry — registre de sources
 * @returns racine de l'arbre (nœuds thèmes + actions)
 *
 * @example
 *   const tree = buildUITree(context, registry);
 *   // tree = [
 *   //   { id: "identite", label: "Identité", children: [...], ... },
 *   //   { id: "urbanisme", label: "Urbanisme", children: [...], ... },
 *   //   ...
 *   // ]
 */
export function buildUITree(ctx: NavigationContext, reg: Registry): UITreeNode[] {
  // Pas de territoire résolu → arbre vide
  if (!ctx.level) return [];

  const themes = reg.getThemes(ctx.level);
  return themes.map((theme) => buildThemeNode(ctx, reg, theme));
}

/**
 * Construit un nœud thème avec ses sous-nœuds actions.
 */
function buildThemeNode(
  ctx: NavigationContext,
  reg: Registry,
  theme: Theme,
): UITreeNode {
  const meta = THEME_META[theme];
  const actionDefs = reg.getActionDefs(ctx.level!, theme);

  // Construire les nœuds enfants (actions)
  const children: UITreeNode[] = actionDefs.map((actionDef) => {
    const sources = reg.getSources(ctx.level!, theme, actionDef.id);
    const sourceIds = sources.map((s) => s.id);

    // Badge : données chargées > compteur pré-calculé > null
    let badge: number | null = null;
    if (ctx.theme === theme && ctx.data[actionDef.id] !== undefined) {
      const data = ctx.data[actionDef.id];
      badge = Array.isArray(data) ? data.length : null;
    } else {
      // Utiliser les compteurs pré-calculés si disponibles
      const count = sources.reduce((sum, s) => {
        const c = ctx.counts?.[s.id];
        return c != null && c >= 0 ? sum + c : sum;
      }, 0);
      const hasCounts = sources.some((s) => ctx.counts?.[s.id] != null);
      if (hasCounts) badge = count;
    }

    return {
      id: `${theme}.${actionDef.id}`,
      label: actionDef.label,
      description: actionDef.description,
      icon: meta.icon,
      sourceIds,
      badge,
      enabled: true,
    };
  });

  // Sources sans action (vue d'ensemble du thème)
  const overviewSources = reg.getSources(ctx.level!, theme).filter((s) => !s.action);
  const overviewSourceIds = overviewSources.map((s) => s.id);

  // Thème actif ?
  const isActive = ctx.theme === theme;

  return {
    id: theme,
    label: meta.label,
    description: meta.description,
    icon: meta.icon,
    children: children.length > 0 ? children : undefined,
    sourceIds: overviewSourceIds,
    badge: isActive && ctx.data._count !== undefined ? (ctx.data._count as number) : null,
    enabled: true,
  };
}

// ==========================================================================
// Génération de description pour le tool `action`
// ==========================================================================

/**
 * Génère la description dynamique du tool `action` selon le contexte.
 *
 * Si pas de thème actif → liste les thèmes disponibles.
 * Si thème actif → liste les actions disponibles dans ce thème.
 *
 * @param ctx — contexte courant
 * @param reg — registre
 * @returns description en français pour le LLM
 *
 * @example
 *   // Contexte : commune Loray, pas de thème
 *   buildActionDescription(ctx, registry)
 *   → "Consulter les données de Loray (25349). Thèmes : Identité, Urbanisme, Cadastre, ..."
 *
 *   // Contexte : commune Loray, thème urbanisme
 *   buildActionDescription(ctx, registry)
 *   → "Agir sur les données urbanisme de Loray. Actions : Document en vigueur, Zonages, ..."
 */
export function buildActionDescription(ctx: NavigationContext, reg: Registry): string {
  if (!ctx.level || !ctx.name) return "Naviguer d'abord vers un territoire.";

  if (!ctx.theme) {
    // Lister les thèmes avec compteurs si disponibles
    const themes = reg.getThemes(ctx.level);
    const labels = themes.map((t) => {
      const meta = THEME_META[t];
      // Agréger les compteurs des sources de ce thème
      const sources = reg.getSources(ctx.level!, t).filter((s) => s.action);
      const total = sources.reduce((sum, s) => {
        const c = ctx.counts?.[s.id];
        return c != null && c >= 0 ? sum + c : sum;
      }, 0);
      const hasCounts = sources.some((s) => ctx.counts?.[s.id] != null);
      return hasCounts && total > 0 ? `${meta.label} (${total})` : meta.label;
    });
    return `Consulter les données de ${ctx.name} (${ctx.code}). Thèmes disponibles : ${labels.join(", ")}.`;
  }

  // Lister les actions du thème actif + les autres thèmes
  const actionDefs = reg.getActionDefs(ctx.level, ctx.theme);
  const meta = THEME_META[ctx.theme];
  const otherThemes = reg.getThemes(ctx.level)
    .filter((t) => t !== ctx.theme)
    .map((t) => THEME_META[t].label);

  const parts: string[] = [];

  if (actionDefs.length === 0) {
    parts.push(`${meta.label} de ${ctx.name} — données chargées.`);
  } else {
    const actionLabels = actionDefs.map((a) => a.label);
    parts.push(`Agir sur ${meta.label.toLowerCase()} de ${ctx.name}. Actions : ${actionLabels.join(", ")}.`);
  }

  if (otherThemes.length > 0) {
    parts.push(`Autres thèmes : ${otherThemes.join(", ")}.`);
  }

  return parts.join(" ");
}

/**
 * Génère les enums dynamiques pour le tool `action`.
 *
 * @returns tableau d'IDs utilisables comme enum Zod
 *
 * @example
 *   buildActionEnums(ctx, registry)
 *   → ["identite", "urbanisme", "cadastre", "risques", ...]  // sans thème
 *   → ["document", "zonages", "prescriptions", "servitudes"]  // thème actif
 */
export function buildActionEnums(ctx: NavigationContext, reg: Registry): string[] {
  if (!ctx.level) return [];

  if (!ctx.theme) {
    return reg.getThemes(ctx.level);
  }

  // Sous-actions du thème courant + autres thèmes accessibles
  const actions = reg.getActions(ctx.level, ctx.theme);
  const otherThemes = reg.getThemes(ctx.level).filter((t) => t !== ctx.theme);
  return [...actions, ...otherThemes];
}

// ==========================================================================
// Export des métadonnées thème (utile pour d'autres modules)
// ==========================================================================

export { THEME_META };
