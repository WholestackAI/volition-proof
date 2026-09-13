/**
 * Product identity for a compiled business.
 *
 * The first declared entity is a noun *inside* the business, not the name of
 * the product built around it. A restoration operations platform whose first
 * entity happens to be `job` must not present itself to its operators as
 * "Job" — that is a table name wearing a product's clothes, and it shows up in
 * the page title, the app shell, the login screen, and the browser tab.
 *
 * Identity is derived, never hardcoded per customer:
 *
 *   1. An explicit name in the prompt wins ("call it Riverbend Ops").
 *   2. Otherwise the operating surface the prompt asks for names the product.
 *      Software that dispatches crews to sites is a field-operations command
 *      centre whatever industry it serves; software that chases invoices is a
 *      revenue desk. The surface table is keyed on what the software *does*,
 *      so no industry owns a branded string here.
 *   3. `Operations Console` is the honest floor when nothing narrower is
 *      evidenced — still a product name, never an entity noun.
 *
 * Consumed by the canonical compiler (ISL `domain <name>` → AppContract
 * `appName` → generated metadata/shell/login) and by Studio's presentation
 * seed, so Quick look and the built application agree on what they are.
 */

export interface AppIdentity {
  /**
   * `lower_snake_case` identifier, as `ResolvedIntentV2.appId` requires. The
   * ISL lowering pascal-cases it into `domain FieldCommand`, which becomes
   * `AppContract.appName`, which the generator humanises back to the name.
   */
  readonly appId: string;
  /** Product name for titles, headings, shell, login, and navigation. */
  readonly name: string;
  /** Which operating surface produced the name. Recorded so it is auditable. */
  readonly surface: string;
  /** How the name was reached: stated by the operator, or derived from the surface. */
  readonly origin: 'stated' | 'surface';
}

interface SurfaceRule {
  readonly id: string;
  readonly name: string;
  readonly test: RegExp;
}

/**
 * Operating surfaces, most specific first. Each name describes the *shape of
 * the work*, so any industry that does that work gets a coherent product name
 * without the compiler knowing the industry.
 */
const SURFACES: readonly SurfaceRule[] = [
  {
    id: 'field-operations',
    name: 'Field Command',
    test: /\b(field\s+technician|technicians?|crews?|dispatch(?:es|ing|ed)?|job\s?sites?|site\s+visits?|on-?site|mitigation|drying|route\s+sheet)\b/,
  },
  {
    id: 'case-management',
    name: 'Case Desk',
    test: /\b(cases?|claims?|adjusters?|caseloads?|referrals?|intakes?|settlements?|dockets?|litigation|demand\s+letters?|trial)\b/,
  },
  {
    id: 'clinical',
    name: 'Care Desk',
    test: /\b(patients?|clinicians?|charts?|encounters?|prescriptions?)\b/,
  },
  {
    id: 'laboratory',
    name: 'Bench Control',
    test: /\b(specimens?|assays?|reagents?|lab\s+(?:bench|order|result))\b/,
  },
  {
    id: 'logistics',
    name: 'Lane Control',
    test: /\b(loads?|carriers?|shipments?|freight|manifests?|lanes?)\b/,
  },
  {
    id: 'inventory',
    name: 'Stock Control',
    test: /\b(inventory|warehouses?|skus?|stock\s+levels?|purchase\s+orders?)\b/,
  },
  {
    id: 'scheduling',
    name: 'Schedule Desk',
    test: /\b(appointments?|bookings?|reservations?|shifts?|calendars?)\b/,
  },
  {
    id: 'event-operations',
    name: 'Event Desk',
    test: /\b(wedding|venues?|event\s+days?|run-?of-?show|banquets?|catering)\b/,
  },
  {
    id: 'revenue',
    name: 'Revenue Desk',
    test: /\b(invoices?|payments?|billing|receivables?|subscriptions?)\b/,
  },
  {
    id: 'pipeline',
    name: 'Pipeline Desk',
    test: /\b(leads?|deals?|opportunit(?:y|ies)|quotes?|pipelines?)\b/,
  },
];

const FALLBACK_SURFACE: SurfaceRule = {
  id: 'operations',
  name: 'Operations Console',
  test: /(?:)/,
};

/**
 * Phrases an operator uses to name the thing outright. Deliberately narrow:
 * a false positive here renames somebody's product after a stray sentence.
 */
const STATED_NAME_PATTERNS: readonly RegExp[] = [
  /\b[Cc]all\s+it\s+["“']?([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})["”']?/,
  /\b[Nn]amed?\s+["“']([^"”']{2,48})["”']/,
  /\b[Tt]itled\s+["“']([^"”']{2,48})["”']/,
  /\b(?:product|app|application|platform|system|tool)\s+(?:is\s+)?(?:named|called)\s+["“']?([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})["”']?/,
];

/** Words that would make a "stated" name a description rather than a name. */
const NOT_A_NAME = /^(a|an|the|this|that|it|something|anything|software|app|application|platform|system|tool)$/i;

function statedName(prompt: string): string | null {
  for (const pattern of STATED_NAME_PATTERNS) {
    const match = pattern.exec(prompt);
    const captured = match?.[1]
      ?.trim()
      .replace(/[.,;:!?]+$/, '')
      .replace(/\s+/g, ' ');
    if (!captured) continue;
    const words = captured.split(' ');
    if (words.length === 0 || words.length > 4) continue;
    if (words.some((word) => NOT_A_NAME.test(word))) continue;
    if (!/[A-Za-z]/.test(captured)) continue;
    return captured;
  }
  return null;
}

function surfaceFor(prompt: string): SurfaceRule {
  const text = prompt.toLowerCase();
  return SURFACES.find((surface) => surface.test.test(text)) ?? FALLBACK_SURFACE;
}

/** `Field Command` → `field_command`; always a legal ResolvedIntent identifier. */
export function identifierForName(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+/, '');
  return snake || 'operations_console';
}

/**
 * Derive the product identity for a compiled business.
 *
 * `entityIds` is accepted so callers can pass what they already computed; it is
 * used only to *reject* an identity that collides with a plain entity noun,
 * never to build one.
 */
export function deriveAppIdentity(input: {
  prompt: string;
  entityIds?: readonly string[];
}): AppIdentity {
  const stated = statedName(input.prompt);
  const entityNouns = new Set((input.entityIds ?? []).map((id) => id.toLowerCase().replace(/_/g, ' ')));
  if (stated && !entityNouns.has(stated.toLowerCase())) {
    return {
      appId: identifierForName(stated),
      name: stated,
      surface: surfaceFor(input.prompt).id,
      origin: 'stated',
    };
  }
  const surface = surfaceFor(input.prompt);
  return {
    appId: identifierForName(surface.name),
    name: surface.name,
    surface: surface.id,
    origin: 'surface',
  };
}
