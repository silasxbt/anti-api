import { test, expect, describe } from "bun:test"
import { cleanJsonSchemaForGemini } from "../src/lib/json-schema-cleaner"

describe("cleanJsonSchemaForGemini", () => {
    test("removes enumDescriptions and migrates them to description", () => {
        const schema = {
            type: "object",
            properties: {
                mode: {
                    type: "string",
                    enum: ["sync", "async"],
                    enumDescriptions: [
                        "Wait for command completion",
                        "Wait for initial signal"
                    ],
                    description: "Execution mode"
                }
            }
        }

        const cleaned = cleanJsonSchemaForGemini(schema)
        expect(cleaned.properties.mode.enumDescriptions).toBeUndefined()
        expect(cleaned.properties.mode.description).toBe("Execution mode (Options: sync: Wait for command completion; async: Wait for initial signal)")
        expect(cleaned.properties.mode.enum).toEqual(["sync", "async"])
    })

    test("handles markdownDescription and title fallback", () => {
        const schema = {
            type: "object",
            properties: {
                fieldA: {
                    type: "string",
                    markdownDescription: "Detailed markdown description"
                },
                fieldB: {
                    type: "number",
                    title: "Field B Title"
                }
            }
        }

        const cleaned = cleanJsonSchemaForGemini(schema)
        expect(cleaned.properties.fieldA.markdownDescription).toBeUndefined()
        expect(cleaned.properties.fieldA.description).toBe("Detailed markdown description")
        expect(cleaned.properties.fieldB.title).toBeUndefined()
        expect(cleaned.properties.fieldB.description).toBe("Field B Title")
    })

    test("removes unsupported fields like $schema, $comment, additionalProperties", () => {
        const schema = {
            $schema: "http://json-schema.org/draft-07/schema#",
            $comment: "test comment",
            type: "object",
            additionalProperties: false,
            properties: {
                id: {
                    type: "string",
                    default: "abc",
                    examples: ["xyz"]
                }
            }
        }

        const cleaned = cleanJsonSchemaForGemini(schema)
        expect(cleaned.$schema).toBeUndefined()
        expect(cleaned.$comment).toBeUndefined()
        expect(cleaned.additionalProperties).toBeUndefined()
        expect(cleaned.properties.id.default).toBeUndefined()
        expect(cleaned.properties.id.examples).toBeUndefined()
    })
})
