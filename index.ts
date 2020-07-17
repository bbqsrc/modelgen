// Import the yaml library, installed from npm
import * as yaml from "js-yaml"

// Import the fs library, built into node.js's standard library
import fs from "fs"

type AstModel = unknown[] | Record<string, unknown> | string

type Ast = {
    models: { [key: string]: AstModel }
}

enum JsType {
    Null,
    Array,
    Object,
    Boolean,
    String,
    BigInt,
    Symbol,
    Undefined,
    Number
}

class TypeSpec {
    isArray: boolean
    type: string | TypeSpec

    constructor(type: string | TypeSpec, isArray = false) {
        this.isArray = isArray
        this.type = type
    }
}

class StructSpec {
    name: string
    fields: { [name: string]: TypeSpec }

    constructor(name: string, fields: { [name: string]: TypeSpec }) {
        this.name = name
        this.fields = fields
    }
}

class TupleStructSpec {
    name: string
    operands: TypeSpec[]

    constructor(name: string, operands: TypeSpec[]) {
        this.name = name
        this.operands = operands
    }
}

class EnumSpec {
    name: string
    cases: { [name: string]: CaseSpec }

    constructor(name: string, cases: { [name: string]: CaseSpec }) {
        this.name = name
        this.cases = cases
    }
}

class CaseSpec {
    operands: TypeSpec[]

    constructor(operands: TypeSpec[]) {
        this.operands = operands
    }
}

function typeOf(value: unknown): JsType {
    if (value === null) {
        return JsType.Null
    }

    if (Array.isArray(value)) {
        return JsType.Array
    }

    switch (typeof value) {
        case "object":
            return JsType.Object
        case "boolean":
            return JsType.Boolean
        case "string":
            return JsType.String
        case "number":
            return JsType.Number
        case "undefined":
            return JsType.Undefined
        case "symbol":
            return JsType.Symbol
        case "bigint":
            return JsType.BigInt
        default:
            throw new Error(`Unknown type from typeof: ${typeof value}`)
    }
}

type TopLevelSpec = TupleStructSpec | EnumSpec | StructSpec

class RustGenerator {
    private readonly models: TopLevelSpec[]

    constructor(models: TopLevelSpec[]) {
        this.models = models
    }

    resolveType(spec: string | TypeSpec): string {
        if (typeof spec === "string") {
            return spec
        }

        if (spec.isArray) {
            return `Vec<${this.resolveType(spec.type)}>`
        }

        return this.resolveType(spec.type)
    }

    generateTupleStruct(model: TupleStructSpec) {
        if (model.operands.length > 0) {
            const operands = model.operands.map(x => this.resolveType(x)).join(", ")
            console.log(`pub(crate) struct ${model.name}(${operands});\n`)
        } else {
            console.log(`pub(crate) struct ${model.name};\n`)
        }
    }

    generateStruct(model: StructSpec) {
        let s = `pub(crate) struct ${model.name} {\n`
        
        const fields = Object.entries(model.fields).map(([key, value]) => {
            return `    ${key}: ${this.resolveType(value)},`
        })

        s += fields.join("\n")
        s += `\n}\n`
        console.log(s)
    }

    generateEnum(model: EnumSpec) {
        let s = `pub(crate) enum ${model.name} {\n`
        const cases = Object.entries(model.cases).map(([key, value]) => {
            if (value.operands.length === 0) {
                return `    ${key},`
            } else {
                return `    ${key}(${value.operands.map(x => this.resolveType(x)).join(", ")}),`
            }
        })

        s += cases.join("\n")
        s += `\n}\n`
        console.log(s)
    }

    generate() {
        for (const model of this.models) {
            if (model instanceof TupleStructSpec) {
                this.generateTupleStruct(model)
            } else if (model instanceof EnumSpec) {
                this.generateEnum(model)
            } else if (model instanceof StructSpec) {
                this.generateStruct(model)
            } else {
                throw new TypeError("impossible")
            }
        }
    }
}


class AstParser {
    private readonly ast: Ast

    constructor(ast: Ast) {
        this.ast = ast
    }

    parseStruct(structName: string, structFields: Record<string, unknown>): StructSpec {
        const fields: { [name: string]: TypeSpec } = {}
    
        for (const [fieldName, fieldValue] of Object.entries(structFields)) {
            const type = typeOf(fieldValue)
    
            if (type === JsType.Array) {
                fields[fieldName] = new TypeSpec((fieldValue as string[])[0], true)
            } else if (type === JsType.String) {
                fields[fieldName] = new TypeSpec(fieldValue as string)
            } else {
                throw new Error(`Unhandled type: ${type}`)
            }
        }
    
        return new StructSpec(structName, fields)
    }
    
    parseEnumValueArray(array: unknown[]): CaseSpec {
        // Empty case
        if (array.length === 0) {
            return new CaseSpec([])
        }

        if (array.length === 1) {
            return new CaseSpec([new TypeSpec((array as string[])[0], true)])
        }

        return new CaseSpec(array.map(obj => {
            const type = typeOf(obj)

            if (type === JsType.Array) {
                return new TypeSpec((obj as string[])[0], true)
            } else if (type === JsType.String) {
                return new TypeSpec(obj as string)
            } else {
                throw new Error(`Unknown type: ${type}`)
            }
        }))
    }

    parseEnum(enumName: string, enumValues: unknown[]): EnumSpec {
        const cases: { [name: string]: CaseSpec } = {}
    
        for (const value of enumValues) {
            const type = typeOf(value)
    
            if (type === JsType.String) {
                const v = value as string
                cases[v] = new CaseSpec([new TypeSpec(v)])
            } else if (type === JsType.Object) {
                const v = value as Record<string, unknown>
                const [key, innerTypeObj]: [string, unknown] = Object.entries(v)[0]
                const innerType = typeOf(innerTypeObj)
    
                if (innerType === JsType.String) {
                    cases[key] = new CaseSpec([new TypeSpec(innerTypeObj as string)])
                } else if (innerType === JsType.Array) {
                    cases[key] = this.parseEnumValueArray(innerTypeObj as unknown[])
                } else {
                    throw new Error(`Unknown type: ${type}`)
                }
            } else {
                throw new Error(`Unhandled JS type: ${type}`)
            }
        }
    
        return new EnumSpec(enumName, cases)
    }

    parse(): TopLevelSpec[] {
        const models: TopLevelSpec[] = Object.entries(this.ast.models).map(([key, value]) => {
            const type = typeOf(value)
            
            if (type === JsType.String) {
                return new TupleStructSpec(key, [new TypeSpec(value as string)])
            } else if (type === JsType.Object) {
                return this.parseStruct(key, value as Record<string, unknown>)
            } else if (type === JsType.Array) {
                return this.parseEnum(key, value as unknown[])
            } else {
                console.log(`Warning: Unhandled type for key "${key}": ${type}`)
            }
        }).filter(x => x != null) as TopLevelSpec[]

        return models
    }
}

function main() {
    // Read the ast.yaml file from the current directory as a string
    const yamlData = fs.readFileSync("./ast.yaml", "utf8")

    // Parse the YAML string into a JavaScript object
    const obj = yaml.safeLoad(yamlData) as Ast | null

    if (obj == null) {
        throw new Error("Invalid input")
    }

    if (typeof obj.models !== "object") {
        throw new Error("Invalid input")
    }

    const parser = new AstParser(obj)
    const models = parser.parse()

    console.log(JSON.stringify(models, null, 2))

    const generator = new RustGenerator(models)
    generator.generate()
}

// Run our program
main()
