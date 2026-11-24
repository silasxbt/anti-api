/**
 * JSON Schema Cleaner for Gemini v1internal API
 * Ported from proj-1/src-tauri/src/proxy/common/json_schema.rs
 * 
 * Key features:
 * 1. Expand $ref and $defs
 * 2. Remove unsupported fields ($schema, additionalProperties, format, default, etc.)
 * 3. Handle union types: ["string", "null"] -> "string"
 * 4. Handle anyOf/oneOf: extract first non-null type
 * 5. Convert type to lowercase
 * 6. Ensure enum values are all strings
 * 7. Remove required fields that don't exist in properties
 */

// Fields to be migrated to description as constraints
const VALIDATION_FIELDS = [
    'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
    'minItems', 'maxItems', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf'  // Removed 'format' - should be hard removed instead
]

// Fields to be completely removed
const HARD_REMOVE_FIELDS = [
    '$schema', '$id', '$comment', 'additionalProperties', 'enumCaseInsensitive',
    'enumNormalizeWhitespace', 'uniqueItems', 'default', 'const',
    'examples', 'example', 'propertyNames', 'anyOf', 'oneOf', 'allOf', 'not',
    'if', 'then', 'else', 'dependencies', 'dependentSchemas',
    'dependentRequired', 'cache_control', 'contentEncoding',
    'contentMediaType', 'deprecated', 'readOnly', 'writeOnly',
    'format',  // Added - Gemini doesn't support format
    'enumDescriptions', 'markdownDescription', 'markdownEnumDescriptions',
    'enumItemLabels', 'title'
]

/**
 * Main entry point - clean JSON schema for Gemini compatibility
 */
export function cleanJsonSchemaForGemini(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema

    // Deep clone to avoid mutating original
    let value = JSON.parse(JSON.stringify(schema))

    // Step 0: Flatten $refs
    if (typeof value === 'object' && value !== null) {
        const defs: Record<string, any> = {}
        if (value.$defs && typeof value.$defs === 'object') {
            Object.assign(defs, value.$defs)
            delete value.$defs
        }
        if (value.definitions && typeof value.definitions === 'object') {
            Object.assign(defs, value.definitions)
            delete value.definitions
        }
        if (Object.keys(defs).length > 0) {
            flattenRefs(value, defs)
        }
    }

    // Step 1: Recursive clean
    cleanJsonSchemaRecursive(value)

    return value
}

/**
 * Recursively expand $ref references
 */
function flattenRefs(obj: any, defs: Record<string, any>): void {
    if (!obj || typeof obj !== 'object') return

    // Handle $ref
    if (obj.$ref && typeof obj.$ref === 'string') {
        const refName = obj.$ref.split('/').pop() || obj.$ref
        delete obj.$ref

        if (defs[refName] && typeof defs[refName] === 'object') {
            // Merge definition into current object
            for (const [k, v] of Object.entries(defs[refName])) {
                if (!(k in obj)) {
                    obj[k] = JSON.parse(JSON.stringify(v))
                }
            }
            // Recursively flatten in case of nested refs
            flattenRefs(obj, defs)
        }
    }

    // Recurse into children
    for (const key of Object.keys(obj)) {
        const v = obj[key]
        if (v && typeof v === 'object') {
            if (Array.isArray(v)) {
                for (const item of v) {
                    if (item && typeof item === 'object') {
                        flattenRefs(item, defs)
                    }
                }
            } else {
                flattenRefs(v, defs)
            }
        }
    }
}

/**
 * Recursive cleaning of schema nodes
 */
function cleanJsonSchemaRecursive(value: any): void {
    if (!value || typeof value !== 'object') return

    if (Array.isArray(value)) {
        for (const item of value) {
            cleanJsonSchemaRecursive(item)
        }
        return
    }

    // 1. Recurse into all children first
    for (const key of Object.keys(value)) {
        cleanJsonSchemaRecursive(value[key])
    }

    // 2. Migrate markdownDescription / title if description is absent
    if (!value.description && typeof value.markdownDescription === 'string' && value.markdownDescription.trim()) {
        value.description = value.markdownDescription.trim()
    } else if (!value.description && typeof value.title === 'string' && value.title.trim()) {
        value.description = value.title.trim()
    }

    // 2b. Migrate enumDescriptions / markdownEnumDescriptions to description
    const enumDescs = Array.isArray(value.enumDescriptions)
        ? value.enumDescriptions
        : Array.isArray(value.markdownEnumDescriptions)
            ? value.markdownEnumDescriptions
            : null
    if (enumDescs && Array.isArray(value.enum)) {
        const enumHelp: string[] = []
        for (let i = 0; i < value.enum.length; i++) {
            const val = value.enum[i]
            const desc = enumDescs[i]
            if (desc && typeof desc === 'string' && desc.trim()) {
                enumHelp.push(`${val}: ${desc.trim()}`)
            }
        }
        if (enumHelp.length > 0) {
            const suffix = ` (Options: ${enumHelp.join('; ')})`
            value.description = (value.description || '') + suffix
        }
    }

    // 2c. Migrate validation fields to description
    const constraints: string[] = []
    for (const field of VALIDATION_FIELDS) {
        if (field in value) {
            const val = value[field]
            // Only migrate simple values
            if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
                constraints.push(`${field}: ${val}`)
                delete value[field]
            }
            // If it's an object (e.g., a property named "pattern"), keep it
        }
    }

    if (constraints.length > 0) {
        const suffix = ` [Constraint: ${constraints.join(', ')}]`
        value.description = (value.description || '') + suffix
    }

    // 3. Extract type from anyOf/oneOf before removing them
    if (!value.type) {
        const anyOf = value.anyOf || value.oneOf
        if (Array.isArray(anyOf)) {
            const extracted = extractTypeFromUnion(anyOf)
            if (extracted) {
                value.type = extracted
            }
        }
    }

    // 4. Remove hard blacklist fields
    for (const field of HARD_REMOVE_FIELDS) {
        delete value[field]
    }

    // 5. Ensure required fields exist in properties
    if (Array.isArray(value.required) && value.properties) {
        const propKeys = new Set(Object.keys(value.properties))
        value.required = value.required.filter((k: any) =>
            typeof k === 'string' && propKeys.has(k)
        )
    } else if (Array.isArray(value.required) && !value.properties) {
        value.required = []
    }

    // 6. Normalize type field
    if (value.type) {
        if (Array.isArray(value.type)) {
            // ["string", "null"] -> "string"
            let selected = 'string'
            for (const t of value.type) {
                if (typeof t === 'string' && t !== 'null') {
                    selected = t.toLowerCase()
                    break
                }
            }
            value.type = selected
        } else if (typeof value.type === 'string') {
            value.type = value.type.toLowerCase()
        }
    }

    // 7. Ensure enum values are all strings
    if (Array.isArray(value.enum)) {
        value.enum = value.enum.map((item: any) => {
            if (typeof item === 'string') return item
            if (typeof item === 'number') return String(item)
            if (typeof item === 'boolean') return String(item)
            if (item === null) return 'null'
            return JSON.stringify(item)
        })
    }
}

/**
 * Extract first non-null type from anyOf/oneOf array
 */
function extractTypeFromUnion(unionArray: any[]): string | null {
    for (const item of unionArray) {
        if (item && typeof item === 'object' && typeof item.type === 'string') {
            if (item.type !== 'null') {
                return item.type.toLowerCase()
            }
        }
    }
    return null
}
