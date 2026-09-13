// ============================================================================
// ISL (Intent Specification Language) — Peggy Grammar
//
// Canonical grammar definition. Produces AST nodes matching @isl-lang/parser
// ast.ts types. This file IS the language specification.
//
// Precedence (low to high):
//   or/||  and/&&  implies/iff  ==/!=  </>/<=/>=/in  +/-  */%  not/-  ./()/[]
// ============================================================================

{
  // Location helper — maps peggy location to ISL SourceLocation
  function loc() {
    const l = location();
    return {
      file: options.filename || '<input>',
      line: l.start.line,
      column: l.start.column,
      endLine: l.end.line,
      endColumn: l.end.column,
    };
  }

  // Left-fold binary expressions
  function buildBinaryChain(head, tail) {
    return tail.reduce((left, [, op, , right]) => ({
      kind: 'BinaryExpr',
      operator: op,
      left,
      right,
      location: loc(),
    }), head);
  }
}

// ============================================================================
// TOP LEVEL
// ============================================================================

Program
  = _ d:Domain _ { return d; }

Domain
  = "domain" __ name:Identifier _
    "{" _ members:DomainMember* _ "}" {
      const domain = {
        kind: 'Domain',
        name,
        version: { kind: 'StringLiteral', value: '1.0.0', location: loc() },
        owner: undefined,
        imports: [],
        types: [],
        entities: [],
        behaviors: [],
        invariants: [],
        policies: [],
        views: [],
        scenarios: [],
        chaos: [],
        location: loc(),
      };
      for (const m of members) {
        if (!m) continue;
        switch (m._memberKind) {
          case 'version': domain.version = m.value; break;
          case 'owner': domain.owner = m.value; break;
          case 'import': domain.imports.push(m.value); break;
          case 'type': domain.types.push(m.value); break;
          case 'entity': domain.entities.push(m.value); break;
          case 'behavior': domain.behaviors.push(m.value); break;
          case 'invariantBlock': domain.invariants.push(m.value); break;
          case 'policy': domain.policies.push(m.value); break;
          case 'view': domain.views.push(m.value); break;
          case 'scenarioBlock': domain.scenarios.push(m.value); break;
          case 'chaosBlock': domain.chaos.push(m.value); break;
        }
      }
      return domain;
    }

DomainMember
  = m:VersionField     { return { _memberKind: 'version', value: m }; }
  / m:OwnerField       { return { _memberKind: 'owner', value: m }; }
  / m:ImportDecl       { return { _memberKind: 'import', value: m }; }
  / m:TypeDeclaration  { return { _memberKind: 'type', value: m }; }
  / m:EnumDeclaration  { return { _memberKind: 'type', value: m }; }
  / m:EntityDecl       { return { _memberKind: 'entity', value: m }; }
  / m:BehaviorDecl     { return { _memberKind: 'behavior', value: m }; }
  / m:InvariantBlock   { return { _memberKind: 'invariantBlock', value: m }; }
  / m:PolicyDecl       { return { _memberKind: 'policy', value: m }; }
  / m:ViewDecl         { return { _memberKind: 'view', value: m }; }
  / m:ScenarioBlock    { return { _memberKind: 'scenarioBlock', value: m }; }
  / m:StandaloneScenario { return { _memberKind: 'scenarioBlock', value: { kind: 'ScenarioBlock', behaviorName: { kind: 'Identifier', name: 'global', location: loc() }, scenarios: [m.value], location: loc() } }; }
  / m:ChaosBlock       { return { _memberKind: 'chaosBlock', value: m }; }
  / Comment _          { return null; }

VersionField
  = "version" _ ":" _ v:StringLit _ { return v; }
  / "version" __ v:StringLit _      { return v; }

OwnerField
  = "owner" _ ":" _ v:StringLit _ { return v; }
  / "owner" __ v:StringLit _      { return v; }

// ============================================================================
// IMPORTS
// ============================================================================

ImportDecl
  = "imports" _ "{" _ items:ImportItemList _ "}" _ "from" __ source:StringLit _ {
      return { kind: 'Import', items, from: source, location: loc() };
    }

ImportItemList
  = head:ImportItem tail:(_ "," _ ImportItem)* (_ ",")? {
      return [head, ...tail.map(t => t[3])];
    }

ImportItem
  = name:Identifier _ "as" __ alias:Identifier {
      return { kind: 'ImportItem', name, alias, location: loc() };
    }
  / name:Identifier {
      return { kind: 'ImportItem', name, alias: undefined, location: loc() };
    }

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

TypeDeclaration
  = "type" __ name:Identifier _ "=" _ def:TypeDefinition annots:(_ Annotation)* _ {
      return {
        kind: 'TypeDeclaration',
        name,
        definition: def,
        annotations: annots.map(a => a[1]),
        location: loc(),
      };
    }

EnumDeclaration
  = "enum" __ name:Identifier _ "{" _ variants:EnumVariantList _ "}" {
      return {
        kind: 'TypeDeclaration',
        name,
        definition: { kind: 'EnumType', variants, location: loc() },
        annotations: [],
        location: loc(),
      };
    }

EnumVariantList
  = head:EnumVariant tail:(_ EnumVariant)* {
      return [head, ...tail.map(t => t[1])];
    }

EnumVariant
  = name:Identifier _ "=" _ value:Literal _ {
      return { kind: 'EnumVariant', name, value, location: loc() };
    }
  / name:Identifier _ {
      return { kind: 'EnumVariant', name, value: undefined, location: loc() };
    }

TypeDefinition
  = UnionTypeDef

UnionTypeDef
  = head:SingleTypeDef tail:(_ "|" _ SingleTypeDef)+ {
      const variants = [head, ...tail.map(t => t[3])].map(t => ({
        kind: 'UnionVariant',
        name: t.kind === 'ReferenceType' ? t.name.parts[0] : { kind: 'Identifier', name: 'variant', location: loc() },
        fields: t.kind === 'StructType' ? t.fields : [],
        location: t.location,
      }));
      return { kind: 'UnionType', variants, location: loc() };
    }
  / SingleTypeDef

SingleTypeDef
  = base:BaseTypeDef "?" {
      return { kind: 'OptionalType', inner: base, location: loc() };
    }
  / base:BaseTypeDef _ constraints:ConstraintBlock {
      return { kind: 'ConstrainedType', base, constraints, location: loc() };
    }
  / BaseTypeDef

BaseTypeDef
  = "List" _ "<" _ elem:TypeDefinition _ ">" {
      return { kind: 'ListType', element: elem, location: loc() };
    }
  / "Map" _ "<" _ key:TypeDefinition _ "," _ val:TypeDefinition _ ">" {
      return { kind: 'MapType', key, value: val, location: loc() };
    }
  / "{" _ fields:FieldList _ "}" {
      return { kind: 'StructType', fields, location: loc() };
    }
  / PrimitiveTypeName
  / name:QualifiedName {
      return { kind: 'ReferenceType', name, location: loc() };
    }

PrimitiveTypeName
  = t:("String" / "Int" / "Decimal" / "Boolean" / "Timestamp" / "UUID" / "Duration") !IdentChar {
      return { kind: 'PrimitiveType', name: t, location: loc() };
    }

ConstraintBlock
  = "{" _ head:ConstraintItem tail:(_ ConstraintItem)* _ "}" {
      return [head, ...tail.map(t => t[1])];
    }

ConstraintItem
  = name:IdentifierName _ ":" _ value:Expression {
      return { kind: 'Constraint', name, value, location: loc() };
    }

// ============================================================================
// ENTITIES
// ============================================================================

EntityDecl
  = "entity" __ name:Identifier _ "{" _ members:EntityMember* _ "}" {
      const entity = { kind: 'Entity', name, fields: [], invariants: [], lifecycle: undefined, location: loc() };
      for (const m of members) {
        if (!m) continue;
        if (m._kind === 'field') entity.fields.push(m.value);
        else if (m._kind === 'invariants') entity.invariants.push(...m.value);
        else if (m._kind === 'lifecycle') entity.lifecycle = m.value;
      }
      return entity;
    }

EntityMember
  = m:FieldDecl         { return { _kind: 'field', value: m }; }
  / m:InvariantsSection  { return { _kind: 'invariants', value: m }; }
  / m:LifecycleSection   { return { _kind: 'lifecycle', value: m }; }
  / Comment _            { return null; }

FieldDecl
  = name:Identifier _ ":" _ type:TypeDefinition optional:"?"? _ annots:AnnotationList? default_:(_ "=" _ Expression)? _ {
      return {
        kind: 'Field',
        name,
        type,
        optional: optional === '?',
        annotations: annots || [],
        defaultValue: default_ ? default_[3] : undefined,
        location: loc(),
      };
    }

FieldList
  = head:FieldDecl tail:(_ ","? _ FieldDecl)* (_ ",")? {
      return [head, ...tail.map(t => t[3])];
    }
  / _ { return []; }

AnnotationList
  = "[" _ head:AnnotationItem tail:(_ "," _ AnnotationItem)* _ "]" {
      return [head, ...tail.map(t => t[3])];
    }

AnnotationItem
  = name:Identifier _ ":" _ value:Expression {
      return { kind: 'Annotation', name, value, location: loc() };
    }
  / name:Identifier {
      return { kind: 'Annotation', name, value: undefined, location: loc() };
    }

Annotation
  = "@" name:Identifier _ "(" _ value:Expression _ ")" {
      return { kind: 'Annotation', name, value, location: loc() };
    }
  / "@" name:Identifier {
      return { kind: 'Annotation', name, value: undefined, location: loc() };
    }

InvariantsSection
  = "invariants" _ "{" _ exprs:ExpressionList _ "}" _ { return exprs; }

LifecycleSection
  = "lifecycle" _ "{" _ transitions:TransitionList _ "}" _ {
      return { kind: 'LifecycleSpec', transitions, location: loc() };
    }

// Each `Transition` yields an ARRAY of hops (a chain expands to several), so the
// list is the concatenation of those arrays — not `[head, ...tail]`, which would
// also splice in each tail pair's leading-whitespace capture.
TransitionList
  = head:Transition tail:(_ Transition)* { return [...head, ...tail.flatMap(t => t[1])]; }

// A chained transition `A -> B -> C` expands to every hop (A->B, B->C), matching
// the authoritative recursive-descent parser in ../statement-parser.ts. Matching
// only the first hop made this grammar REJECT valid `.isl` the default parser
// accepts — a dual-parser divergence on the behavior source of truth.
Transition
  = from:Identifier _ "->" _ to:Identifier rest:(_ "->" _ Identifier)* _ {
      const hops = [{ kind: 'LifecycleTransition', from, to, location: loc() }];
      let prev = to;
      for (const r of rest) {
        const next = r[3];
        hops.push({ kind: 'LifecycleTransition', from: prev, to: next, location: loc() });
        prev = next;
      }
      return hops;
    }

// ============================================================================
// BEHAVIORS
// ============================================================================

BehaviorDecl
  = "behavior" __ name:Identifier _ "{" _ sections:BehaviorSection* _ "}" {
      const b = {
        kind: 'Behavior', name,
        description: undefined, actors: undefined,
        input: { kind: 'InputSpec', fields: [], location: loc() },
        output: { kind: 'OutputSpec', success: { kind: 'PrimitiveType', name: 'Boolean', location: loc() }, errors: [], location: loc() },
        preconditions: [], postconditions: [], invariants: [],
        temporal: [], security: [], compliance: [],
        observability: undefined,
        location: loc(),
      };
      for (const s of sections) {
        if (!s) continue;
        switch (s._section) {
          case 'description': b.description = s.value; break;
          case 'actors': b.actors = s.value; break;
          case 'input': b.input = s.value; break;
          case 'output': b.output = s.value; break;
          case 'preconditions': b.preconditions = s.value; break;
          case 'postconditions': b.postconditions = s.value; break;
          case 'invariants': b.invariants = s.value; break;
          case 'temporal': b.temporal = s.value; break;
          case 'security': b.security = s.value; break;
          case 'compliance': b.compliance = s.value; break;
        }
      }
      return b;
    }

BehaviorSection
  = s:DescriptionSection      { return { _section: 'description', value: s }; }
  / s:ActorsSection           { return { _section: 'actors', value: s }; }
  / s:InputSection            { return { _section: 'input', value: s }; }
  / s:OutputSection           { return { _section: 'output', value: s }; }
  / s:PreconditionsSection    { return { _section: 'preconditions', value: s }; }
  / s:PostconditionsSection   { return { _section: 'postconditions', value: s }; }
  / s:BehaviorInvariantsSection { return { _section: 'invariants', value: s }; }
  / s:TemporalSection         { return { _section: 'temporal', value: s }; }
  / s:SecuritySection         { return { _section: 'security', value: s }; }
  / s:ComplianceSection       { return { _section: 'compliance', value: s }; }
  / Comment _                 { return null; }

DescriptionSection
  = "description" _ ":" _ v:StringLit _ { return v; }

ActorsSection
  = "actors" _ "{" _ actors:ActorDecl* _ "}" _ { return actors; }

ActorDecl
  = name:Identifier _ "{" _ constraints:ActorConstraintList _ "}" _ {
      return { kind: 'ActorSpec', name, constraints, location: loc() };
    }

ActorConstraintList
  = head:ActorConstraint tail:(_ ActorConstraint)* { return [head, ...tail.map(t => t[1])]; }
  / _ { return []; }

ActorConstraint
  = "must" _ ":" _ expr:Expression _ { return expr; }
  / expr:Expression _ { return expr; }

InputSection
  = ("input" / "in") _ "{" _ fields:FieldList _ "}" _ {
      return { kind: 'InputSpec', fields, location: loc() };
    }

OutputSection
  = ("output" / "out") _ "{" _ members:OutputMember* _ "}" _ {
      const output = {
        kind: 'OutputSpec',
        success: { kind: 'PrimitiveType', name: 'Boolean', location: loc() },
        errors: [],
        location: loc(),
      };
      for (const m of members) {
        if (m._kind === 'success') output.success = m.value;
        else if (m._kind === 'errors') output.errors = m.value;
      }
      return output;
    }

OutputMember
  = "success" _ ":" _ type:TypeDefinition _ {
      return { _kind: 'success', value: type };
    }
  / "errors" _ "{" _ errors:ErrorDecl* _ "}" _ {
      return { _kind: 'errors', value: errors };
    }
  / f:FieldDecl { return { _kind: 'success', value: { kind: 'ReferenceType', name: { kind: 'QualifiedName', parts: [f.name], location: f.location }, location: f.location } }; }

ErrorDecl
  = name:Identifier _ "{" _ props:ErrorProp* _ "}" _ {
      const err = { kind: 'ErrorSpec', name, when: undefined, retriable: false, retryAfter: undefined, returns: undefined, location: loc() };
      for (const p of props) {
        if (p._prop === 'when') err.when = p.value;
        else if (p._prop === 'retriable') err.retriable = p.value;
        else if (p._prop === 'retry_after') err.retryAfter = p.value;
        else if (p._prop === 'returns') err.returns = p.value;
      }
      return err;
    }
  / name:Identifier _ {
      return { kind: 'ErrorSpec', name, when: undefined, retriable: false, retryAfter: undefined, returns: undefined, location: loc() };
    }

ErrorProp
  = "when" _ ":" _ v:StringLit _       { return { _prop: 'when', value: v }; }
  / "retriable" _ ":" _ v:BoolLit _    { return { _prop: 'retriable', value: v.value }; }
  / "retry_after" _ ":" _ v:Expression _ { return { _prop: 'retry_after', value: v }; }
  / "returns" _ ":" _ v:TypeDefinition _ { return { _prop: 'returns', value: v }; }

PreconditionsSection
  = ("preconditions" / "pre") _ "{" _ exprs:ExpressionList _ "}" _ { return exprs; }

PostconditionsSection
  = ("postconditions" / "post") _ "{" _ blocks:PostconditionBlockList _ "}" _ { return blocks; }
  / "post" __ cond:PostconditionCondition _ "{" _ preds:ExpressionList _ "}" _ {
      return [{ kind: 'PostconditionBlock', condition: cond, predicates: preds, location: loc() }];
    }

PostconditionBlockList
  = head:PostconditionEntry tail:(_ PostconditionEntry)* { return [head, ...tail.map(t => t[1])]; }

PostconditionEntry
  = cond:PostconditionCondition _ ("implies" _)? "{" _ preds:ExpressionList _ "}" _ {
      return { kind: 'PostconditionBlock', condition: cond, predicates: preds, location: loc() };
    }
  / cond:PostconditionCondition __ "implies" _ "{" _ preds:ExpressionList _ "}" _ {
      return { kind: 'PostconditionBlock', condition: cond, predicates: preds, location: loc() };
    }

PostconditionCondition
  = "success"   { return 'success'; }
  / "any_error" { return 'any_error'; }
  / id:Identifier { return id; }

BehaviorInvariantsSection
  = "invariants" _ "{" _ exprs:ExpressionList _ "}" _ { return exprs; }

TemporalSection
  = "temporal" _ "{" _ specs:TemporalSpecItem* _ "}" _ { return specs; }

TemporalSpecItem
  = op:TemporalOp __ pred:Expression __ "within" __ dur:DurationLit _ percentile:("(" _ "p" [0-9]+ _ ")")? _ {
      return {
        kind: 'TemporalSpec',
        operator: op,
        predicate: pred,
        duration: dur,
        percentile: percentile ? parseInt(percentile[3].join(''), 10) : undefined,
        location: loc(),
      };
    }
  / op:TemporalOp __ "within" __ dur:DurationLit _ ":" _ pred:Expression _ {
      return { kind: 'TemporalSpec', operator: op, predicate: pred, duration: dur, percentile: undefined, location: loc() };
    }
  / "response" __ "within" __ dur:DurationLit _ percentile:("(" _ "p" [0-9]+ _ ")")? _ {
      return {
        kind: 'TemporalSpec',
        operator: 'response',
        predicate: { kind: 'BooleanLiteral', value: true, location: loc() },
        duration: dur,
        percentile: percentile ? parseInt(percentile[3].join(''), 10) : undefined,
        location: loc(),
      };
    }

TemporalOp
  = "eventually" { return 'eventually'; }
  / "always"     { return 'always'; }
  / "within"     { return 'within'; }
  / "never"      { return 'never'; }
  / "immediately" { return 'immediately'; }

SecuritySection
  = "security" _ "{" _ specs:SecuritySpecItem* _ "}" _ { return specs; }

SecuritySpecItem
  = "requires" __ details:Expression _ {
      return { kind: 'SecuritySpec', type: 'requires', details, location: loc() };
    }
  / "rate_limit" __ details:Expression _ {
      return { kind: 'SecuritySpec', type: 'rate_limit', details, location: loc() };
    }

ComplianceSection
  = "compliance" _ "{" _ specs:ComplianceItem* _ "}" _ { return specs; }

ComplianceItem
  = standard:Identifier _ "{" _ reqs:ExpressionList _ "}" _ {
      return { kind: 'ComplianceSpec', standard, requirements: reqs, location: loc() };
    }

// ============================================================================
// INVARIANT BLOCKS (top-level)
// ============================================================================

InvariantBlock
  = "invariants" __ name:Identifier _ desc:("description" _ ":" _ StringLit _)? scope:("scope" _ ":" _ ("global" / "transaction") _)? "{" _ preds:ExpressionList _ "}" _ {
      return {
        kind: 'InvariantBlock',
        name,
        description: desc ? desc[4] : undefined,
        scope: scope ? scope[4] : 'global',
        predicates: preds,
        location: loc(),
      };
    }

// ============================================================================
// POLICIES
// ============================================================================

PolicyDecl
  = "policy" __ name:Identifier _ "{" _ "applies_to" _ ":" _ target:PolicyTarget _ rules:PolicyRuleList _ "}" {
      return { kind: 'Policy', name, appliesTo: target, rules, location: loc() };
    }

PolicyTarget
  = "all" { return { kind: 'PolicyTarget', target: 'all', location: loc() }; }
  / "[" _ head:Identifier tail:(_ "," _ Identifier)* _ "]" {
      return { kind: 'PolicyTarget', target: [head, ...tail.map(t => t[3])], location: loc() };
    }

PolicyRuleList
  = "rules" _ "{" _ rules:PolicyRule* _ "}" _ { return rules; }
  / _ { return []; }

PolicyRule
  = "when" _ cond:Expression _ ":" _ action:Expression _ {
      return { kind: 'PolicyRule', condition: cond, action, location: loc() };
    }
  / "default" _ ":" _ action:Expression _ {
      return { kind: 'PolicyRule', condition: undefined, action, location: loc() };
    }

// ============================================================================
// VIEWS
// ============================================================================

ViewDecl
  = "view" __ name:Identifier _ "for" __ entity:QualifiedName _ "{" _ members:ViewMember* _ "}" {
      const view = {
        kind: 'View', name,
        forEntity: { kind: 'ReferenceType', name: entity, location: entity.location },
        fields: [], consistency: { kind: 'ConsistencySpec', mode: 'eventual', location: loc() },
        cache: undefined,
        location: loc(),
      };
      for (const m of members) {
        if (m._kind === 'field') view.fields.push(m.value);
        else if (m._kind === 'consistency') view.consistency = m.value;
        else if (m._kind === 'cache') view.cache = m.value;
      }
      return view;
    }

ViewMember
  = "fields" _ "{" _ fields:ViewFieldList _ "}" _ { return { _kind: 'field', value: fields }; }
  / "consistency" _ ":" _ mode:("strong" / "eventual") _ { return { _kind: 'consistency', value: { kind: 'ConsistencySpec', mode, location: loc() } }; }
  / "cache" _ "{" _ "ttl" _ ":" _ ttl:DurationLit _ inv:("invalidate_on" _ ":" _ Expression _)? "}" _ {
      return { _kind: 'cache', value: { kind: 'CacheSpec', ttl, invalidateOn: inv ? [inv[4]] : [], location: loc() } };
    }

ViewFieldList
  = head:ViewFieldItem tail:(_ ViewFieldItem)* { return [head, ...tail.map(t => t[1])]; }
  / _ { return []; }

ViewFieldItem
  = name:Identifier _ ":" _ type:TypeDefinition _ "=" _ expr:Expression _ {
      return { kind: 'ViewField', name, type, computation: expr, location: loc() };
    }

// ============================================================================
// SCENARIOS
// ============================================================================

ScenarioBlock
  = "scenarios" __ behaviorName:Identifier _ "{" _ scenarios:ScenarioItem* _ "}" {
      return { kind: 'ScenarioBlock', behaviorName, scenarios, location: loc() };
    }

ScenarioItem
  = "scenario" __ name:StringLit _ "{" _ given:GivenBlock? when:WhenBlock then:ThenBlock "}" _ {
      return { kind: 'Scenario', name, given: given || [], when: when || [], then: then || [], location: loc() };
    }

StandaloneScenario
  = "scenario" __ name:StringLit _ "{" _ given:GivenBlock? when:WhenBlock then:ThenBlock "}" _ {
      return { kind: 'Scenario', name, given: given || [], when: when || [], then: then || [], location: loc() };
    }

GivenBlock
  = "given" _ "{" _ stmts:StatementList _ "}" _ { return stmts; }

WhenBlock
  = "when" _ "{" _ stmts:StatementList _ "}" _ { return stmts; }

ThenBlock
  = "then" _ "{" _ exprs:ExpressionList _ "}" _ { return exprs; }

StatementList
  = head:Statement tail:(_ Statement)* { return [head, ...tail.map(t => t[1])]; }
  / _ { return []; }

Statement
  = target:Identifier _ "=" _ call:CallExpression _ {
      return { kind: 'AssignmentStmt', target, value: call, location: loc() };
    }
  / call:CallExpression _ {
      return { kind: 'CallStmt', target: undefined, call, location: loc() };
    }

// ============================================================================
// CHAOS
// ============================================================================

ChaosBlock
  = "chaos" __ behaviorName:Identifier _ "{" _ scenarios:ChaosScenarioItem* _ "}" {
      return { kind: 'ChaosBlock', behaviorName, scenarios, location: loc() };
    }

ChaosScenarioItem
  = "scenario" __ name:StringLit _ "{" _ members:ChaosScenarioMember* _ "}" _ {
      const inject = [];
      const when = [];
      const thenExprs = [];
      const expectBlock = [];
      let withClause = undefined;
      for (const m of members) {
        if (!m) continue;
        switch (m._kind) {
          case 'injectBlock': inject.push(...m.value); break;
          case 'inlineInject': inject.push(m.value); break;
          case 'when': when.push(...m.value); break;
          case 'then': thenExprs.push(...m.value); break;
          case 'expect': expectBlock.push(...m.value); break;
          case 'with': withClause = m.value; break;
        }
      }
      const injections = inject.map(inj => ({
        kind: 'ChaosInjection',
        type: { kind: 'Identifier', name: typeof inj.type === 'string' ? inj.type : 'database_failure', location: inj.location },
        arguments: (inj.parameters || []).map(p => ({ kind: 'ChaosArgument', name: p.name, value: p.value, location: p.location })),
        location: inj.location,
      }));
      const thenExpectations = thenExprs.map(e => ({
        kind: 'ChaosExpectation', condition: e, expression: e, location: e.location,
      }));
      const expectations = [...expectBlock, ...thenExpectations];
      return {
        kind: 'ChaosScenario', name, inject, when, then: thenExprs,
        injections, expectations,
        withClause, withClauses: withClause ? [withClause] : [],
        location: loc(),
      };
    }

ChaosScenarioMember
  = m:InjectBlock       { return { _kind: 'injectBlock', value: m }; }
  / m:ChaosInlineInject { return { _kind: 'inlineInject', value: m }; }
  / m:ChaosExpectBlock  { return { _kind: 'expect', value: m }; }
  / m:WhenBlock         { return { _kind: 'when', value: m }; }
  / m:ThenBlock         { return { _kind: 'then', value: m }; }
  / m:ChaosWithBlock    { return { _kind: 'with', value: m }; }

InjectBlock
  = "inject" _ "{" _ injections:InjectionItem* _ "}" _ { return injections; }

ChaosInlineInject
  = "inject" __ type:IdentifierName __ "on" __ target:PostfixExpr _ withParams:ChaosInlineWith? _ {
      return {
        kind: 'Injection',
        type: type,
        target: target,
        parameters: withParams || [],
        location: loc(),
      };
    }

ChaosInlineWith
  = "with" _ "{" _ params:InjectionParamList _ "}" {
      return params;
    }

InjectionParamList
  = head:InjectionParam tail:(_ ","? _ InjectionParam)* { return [head, ...tail.map(t => t[3])]; }
  / _ { return []; }

ChaosExpectBlock
  = "expect" _ "{" _ exprs:ExpressionList _ "}" _ {
      return exprs.map(e => ({
        kind: 'ChaosExpectation',
        condition: e,
        expression: e,
        description: undefined,
        location: e.location,
      }));
    }

ChaosWithBlock
  = "with" _ "{" _ args:ChaosArgList _ "}" _ {
      return { kind: 'ChaosWithClause', args, location: loc() };
    }

ChaosArgList
  = head:ChaosArgItem tail:(_ ","? _ ChaosArgItem)* { return [head, ...tail.map(t => t[3])]; }
  / _ { return []; }

ChaosArgItem
  = name:Identifier _ ":" _ value:Expression _ {
      return { kind: 'ChaosArgument', name, value, location: loc() };
    }

InjectionItem
  = type:InjectionTypeName _ target:Expression _ params:InjectionParams? _ {
      return { kind: 'Injection', type, target, parameters: params || [], location: loc() };
    }

InjectionTypeName
  = "database_failure"     { return 'database_failure'; }
  / "network_latency"     { return 'network_latency'; }
  / "network_partition"   { return 'network_partition'; }
  / "service_unavailable" { return 'service_unavailable'; }
  / "cpu_pressure"        { return 'cpu_pressure'; }
  / "memory_pressure"     { return 'memory_pressure'; }
  / "clock_skew"          { return 'clock_skew'; }
  / "concurrent_requests" { return 'concurrent_requests'; }

InjectionParams
  = "{" _ head:InjectionParam tail:(_ "," _ InjectionParam)* _ "}" {
      return [head, ...tail.map(t => t[3])];
    }

InjectionParam
  = name:Identifier _ ":" _ value:Expression {
      return { kind: 'InjectionParam', name, value, location: loc() };
    }

// ============================================================================
// EXPRESSIONS — Operator precedence climbing
// ============================================================================

ExpressionList
  = head:Expression tail:(_ Expression)* { return [head, ...tail.map(t => t[1])]; }
  / _ { return []; }

Expression
  = OrExpr

OrExpr
  = head:AndExpr tail:(_ ("or" / "||") _ AndExpr)* { return buildBinaryChain(head, tail); }

AndExpr
  = head:ImpliesExpr tail:(_ ("and" / "&&") _ ImpliesExpr)* { return buildBinaryChain(head, tail); }

ImpliesExpr
  = head:EqualityExpr tail:(_ ("implies" / "iff") _ EqualityExpr)* { return buildBinaryChain(head, tail); }

EqualityExpr
  = head:ComparisonExpr tail:(_ ("==" / "!=") _ ComparisonExpr)* { return buildBinaryChain(head, tail); }

ComparisonExpr
  = head:AdditiveExpr tail:(_ ("<=" / ">=" / "<" / ">" / "in") _ AdditiveExpr)* { return buildBinaryChain(head, tail); }

AdditiveExpr
  = head:MultiplicativeExpr tail:(_ ("+" / "-") _ MultiplicativeExpr)* { return buildBinaryChain(head, tail); }

MultiplicativeExpr
  = head:UnaryExpr tail:(_ ("*" / "/" / "%") _ UnaryExpr)* { return buildBinaryChain(head, tail); }

UnaryExpr
  = "not" __ operand:UnaryExpr {
      return { kind: 'UnaryExpr', operator: 'not', operand, location: loc() };
    }
  / "-" operand:PostfixExpr {
      return { kind: 'UnaryExpr', operator: '-', operand, location: loc() };
    }
  / PostfixExpr

PostfixExpr
  = head:PrimaryExpr tail:PostfixOp* {
      return tail.reduce((expr, op) => {
        if (op._type === 'member') {
          return { kind: 'MemberExpr', object: expr, property: op.property, location: loc() };
        } else if (op._type === 'call') {
          return { kind: 'CallExpr', callee: expr, arguments: op.args, location: loc() };
        } else if (op._type === 'index') {
          return { kind: 'IndexExpr', object: expr, index: op.index, location: loc() };
        }
        return expr;
      }, head);
    }

PostfixOp
  = "." prop:Identifier { return { _type: 'member', property: prop }; }
  / "(" _ args:ArgList _ ")" { return { _type: 'call', args }; }
  / "[" _ index:Expression _ "]" { return { _type: 'index', index }; }

ArgList
  = head:Expression tail:(_ "," _ Expression)* { return [head, ...tail.map(t => t[3])]; }
  / _ { return []; }

CallExpression
  = callee:QualifiedName _ "(" _ args:ArgList _ ")" {
      return {
        kind: 'CallExpr',
        callee: { kind: 'ReferenceType', name: callee, location: callee.location },
        arguments: args,
        location: loc(),
      };
    }

// ============================================================================
// PRIMARY EXPRESSIONS
// ============================================================================

PrimaryExpr
  = "old" _ "(" _ expr:Expression _ ")" {
      return { kind: 'OldExpr', expression: expr, location: loc() };
    }
  / "result" "." prop:Identifier {
      return { kind: 'ResultExpr', property: prop, location: loc() };
    }
  / "result" !IdentChar {
      return { kind: 'ResultExpr', property: undefined, location: loc() };
    }
  / "input" "." prop:Identifier {
      return { kind: 'InputExpr', property: prop, location: loc() };
    }
  / "now" !IdentChar {
      return { kind: 'CallExpr', callee: { kind: 'Identifier', name: 'now', location: loc() }, arguments: [], location: loc() };
    }
  / quantifier:QuantifierName _ "(" _ collection:Expression _ "," _ lambda:LambdaExpr _ ")" {
      return {
        kind: 'QuantifierExpr',
        quantifier,
        variable: lambda.params[0],
        collection,
        predicate: lambda.body,
        location: loc(),
      };
    }
  / quantifier:QuantifierName __ variable:Identifier __ "in" __ collection:Expression _ ":" _ pred:Expression {
      return { kind: 'QuantifierExpr', quantifier, variable, collection, predicate: pred, location: loc() };
    }
  / "(" _ params:LambdaParams _ ")" _ "=>" _ body:Expression {
      return { kind: 'LambdaExpr', params, body, location: loc() };
    }
  / param:Identifier _ "=>" _ body:Expression {
      return { kind: 'LambdaExpr', params: [param], body, location: loc() };
    }
  / "[" _ elements:ArgList _ "]" {
      return { kind: 'ListExpr', elements, location: loc() };
    }
  / "(" _ expr:Expression _ ")" { return expr; }
  / DurationLit
  / NumberLit
  / StringLit
  / BoolLit
  / NullLit
  / id:Identifier !(_ "=>") { return id; }

QuantifierName
  = "all"    { return 'all'; }
  / "any"    { return 'any'; }
  / "none"   { return 'none'; }
  / "count"  { return 'count'; }
  / "sum"    { return 'sum'; }
  / "filter" { return 'filter'; }

LambdaExpr
  = "(" _ params:LambdaParams _ ")" _ "=>" _ body:Expression {
      return { kind: 'LambdaExpr', params, body, location: loc() };
    }
  / param:Identifier _ "=>" _ body:Expression {
      return { kind: 'LambdaExpr', params: [param], body, location: loc() };
    }

LambdaParams
  = head:Identifier tail:(_ "," _ Identifier)* { return [head, ...tail.map(t => t[3])]; }
  / _ { return []; }

// ============================================================================
// LITERALS
// ============================================================================

Literal
  = StringLit / NumberLit / BoolLit / NullLit / DurationLit

StringLit
  = '"' chars:DoubleStringChar* '"' {
      return { kind: 'StringLiteral', value: chars.join(''), location: loc() };
    }
  / "'" chars:SingleStringChar* "'" {
      return { kind: 'StringLiteral', value: chars.join(''), location: loc() };
    }

DoubleStringChar
  = '\\' c:EscapeChar { return c; }
  / [^"\\]

SingleStringChar
  = '\\' c:EscapeChar { return c; }
  / [^'\\]

EscapeChar
  = 'n' { return '\n'; }
  / 't' { return '\t'; }
  / 'r' { return '\r'; }
  / '\\' { return '\\'; }
  / '"' { return '"'; }
  / "'" { return "'"; }

NumberLit
  = digits:$([0-9]+ "." [0-9]+) {
      return { kind: 'NumberLiteral', value: parseFloat(digits), isFloat: true, location: loc() };
    }
  / digits:$[0-9]+ {
      return { kind: 'NumberLiteral', value: parseInt(digits, 10), isFloat: false, location: loc() };
    }

BoolLit
  = "true" !IdentChar  { return { kind: 'BooleanLiteral', value: true, location: loc() }; }
  / "false" !IdentChar { return { kind: 'BooleanLiteral', value: false, location: loc() }; }

NullLit
  = "null" !IdentChar { return { kind: 'NullLiteral', location: loc() }; }

DurationLit
  = value:$([0-9]+ ("." [0-9]+)?) unit:DurationUnit {
      return { kind: 'DurationLiteral', value: parseFloat(value), unit, location: loc() };
    }
  / value:$([0-9]+ ("." [0-9]+)?) "." unit:DurationUnitDot {
      return { kind: 'DurationLiteral', value: parseFloat(value), unit, location: loc() };
    }

DurationUnit
  = "ms"      { return 'ms'; }
  / "seconds" { return 'seconds'; }
  / "minutes" { return 'minutes'; }
  / "hours"   { return 'hours'; }
  / "days"    { return 'days'; }
  / "s" !IdentChar { return 'seconds'; }
  / "m" !IdentChar { return 'minutes'; }
  / "h" !IdentChar { return 'hours'; }
  / "d" !IdentChar { return 'days'; }

DurationUnitDot
  = "seconds" { return 'seconds'; }
  / "minutes" { return 'minutes'; }
  / "hours"   { return 'hours'; }
  / "days"    { return 'days'; }

// ============================================================================
// IDENTIFIERS
// ============================================================================

Identifier
  = !ReservedWord name:IdentifierName {
      return { kind: 'Identifier', name, location: loc() };
    }

QualifiedName
  = head:Identifier tail:("." Identifier)+ {
      return { kind: 'QualifiedName', parts: [head, ...tail.map(t => t[1])], location: loc() };
    }
  / id:Identifier {
      return { kind: 'QualifiedName', parts: [id], location: loc() };
    }

IdentifierName "identifier"
  = $([a-zA-Z_] IdentChar*)

IdentChar
  = [a-zA-Z0-9_]

ReservedWord
  = ("domain" / "entity" / "behavior" / "type" / "enum"
    / "input" / "output" / "preconditions" / "postconditions" / "invariants"
    / "temporal" / "security" / "compliance" / "actors"
    / "true" / "false" / "null"
    / "and" / "or" / "not" / "implies" / "iff"
    / "old" / "result" / "now"
    / "all" / "any" / "none"
    / "success" / "eventually" / "always" / "within" / "never" / "immediately"
    / "scenario" / "scenarios" / "chaos" / "inject"
    / "given" / "when" / "then"
    / "policy" / "view" / "imports" / "from"
    ) !IdentChar

// ============================================================================
// WHITESPACE & COMMENTS
// ============================================================================

_ "optional whitespace"
  = (WhitespaceChar / Comment)*

__ "required whitespace"
  = (WhitespaceChar / Comment)+

WhitespaceChar
  = [ \t\n\r]

Comment
  = "//" [^\n]* { return null; }
  / "#" [^\n]*  { return null; }
  / "/*" (!"*/" .)* "*/" { return null; }
