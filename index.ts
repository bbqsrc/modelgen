/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-call */
// Import the yaml library, installed from npm
import * as yaml from "js-yaml"
import { Graph, alg } from "graphlib"

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

    isArray(): boolean {
        return this.operands.length === 1 && this.operands[0].isArray
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
type Paths = {
    [x: string]: {
        [x: string]: PathSpec[]
    }
}

type PathSpec = {
    enumName: string;
    enumCase: string;
    typeName: string;
}

class RustGenerator {
    private readonly models: TopLevelSpec[]
    private readonly paths: Paths

    constructor(models: TopLevelSpec[]) {
        this.models = models
        this.paths = this.derivePaths()
    }

    private resolveType(spec: string | TypeSpec): string {
        if (typeof spec === "string") {
            return spec
        }

        if (spec.isArray) {
            return `Vec<${this.resolveType(spec.type)}>`
        }

        return this.resolveType(spec.type)
    }

    private generateTupleStruct(model: TupleStructSpec) {
        if (model.operands.length > 0) {
            const operands = model.operands.map(x => this.resolveType(x)).join(", ")
            console.log(`pub(crate) struct ${model.name}(${operands});\n`)
        } else {
            console.log(`pub(crate) struct ${model.name};\n`)
        }
    }

    private generateStruct(model: StructSpec) {
        let s = `pub(crate) struct ${model.name} {\n`
        
        const fields = Object.entries(model.fields).map(([key, value]) => {
            return `    ${key}: ${this.resolveType(value)},`
        })

        s += fields.join("\n")
        s += `\n}\n`
        console.log(s)
    }

    private generateEnum(model: EnumSpec) {
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

    private generateModels() {
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

    private generateCastFns() {
        Object.entries(this.paths).forEach(([keyFrom, o]) => {
            Object.entries(o).forEach(([keyTo, path]) => {
                const fromType = this.models.find(x => x.name === keyFrom)
                if (fromType == null) {
                    throw new Error(`From type should not be null: ${keyFrom}`)
                }
                const toType = this.models.find(x => x.name === keyTo) || { name: keyTo } as StructSpec
                if (toType == null) {
                    throw new Error(`To type should not be null: ${keyTo}`)
                }
                this.generateCastFn(fromType, toType, path)
            })
        })
    }

    private generateCastFn(fromType: TopLevelSpec, toType: TopLevelSpec, path: PathSpec[]) {
        const letExpr = path.reduceRight((acc, cur) => {
            return `${cur.enumName}::${cur.enumCase}(${acc})`
        }, "value")

        const tryFrom = `\
impl TryFrom<${fromType.name}> for ${toType.name} {
    type Error = CastError<${fromType.name}, ${toType.name}>;

    fn try_from(value: ${fromType.name}) -> Result<Self, Self::Error> {
        if let ${letExpr} = value {
            Ok(value)
        } else {
            Err(CastError::new())
        }
    }
}
`
        const from = `\
impl From<${toType.name}> for ${fromType.name} {
    fn from(value: ${toType.name}) -> Self {
        ${letExpr}
    }
}
`
        console.log(tryFrom)
        console.log(from)
    }

    private derivePaths(): Paths {
        const graph = new Graph({ directed: true })

        // Walk the models and generate paths
        for (const a of this.models) {
            if (a instanceof StructSpec) {
                for (const [key, value] of Object.entries(a.fields)) {
                    const mid = `${a.name}.${key}`;
                    graph.setEdge(a.name, mid)
                    graph.setEdge(mid, this.resolveType(value))
                }
                continue
            }
                
            if (a instanceof TupleStructSpec) {
                continue
            }

            const caseSpecs = Object.entries(a.cases)
                .filter((x) => x[1].operands.length >= 1)

            for (const [key, case_] of caseSpecs) {
                
                for (const operand of case_.operands) {
                    const mid = `${a.name}::${key}#${case_.operands.length}`
                    const resolved = this.resolveType(operand)
                    graph.setEdge(a.name, mid)
                    graph.setEdge(mid, resolved)
                }
            }
        }

        const cycles = alg.findCycles(graph)

        for (const cycleList of cycles) {
            for (const longEnumCase of cycleList.filter(x => x.includes("::"))) {
                const [parent, enumValue] = longEnumCase.split("::")
                const [enumCase, enumIndex] = enumValue.split("#")
                const model = this.models.find(x => x.name === parent) as EnumSpec

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                for (const operand of model.cases[enumCase].operands) {
                    const type = this.resolveType(operand)
                    if (!operand.isArray && type === parent) {
                        operand.type = `Box<${type}>`
                    }
                }
            }

            for (const longStructField of cycleList.filter(x => x.includes("."))) {
                const [parent, structField] = longStructField.split(".")
                const model = this.models.find(x => x.name === parent) as StructSpec
                
                const type = this.resolveType(model.fields[structField])
                model.fields[structField].type = `Box<${type}>`
            }
        }

        const paths = Object.entries(alg.dijkstraAll(graph)).map(([topKey, topValue]) => {
            if (topKey.includes("::") || topKey.includes(".")) {
                return {}
            }

            const paths = Object
                .entries(topValue)
                .map(([key, value]) => {
                    if (value.distance === Infinity) {
                        return null
                    }

                    const path = []
                    path.push(key)
                    
                    while ((key = value.predecessor) != null) {
                        path.push(key)
                        value = topValue[key]
                    }

                    path.pop()
                    path.reverse()

                    // Do some post-processing
                    if (path.length) {
                        if (path[path.length - 1].includes("::") || path.find(x => x.includes(".")) != null) {
                            return null
                        }
                        const newPath = [] 

                        let enumKey = null
                        let typeName = ""

                        for (const key of path) {
                            if (key.includes("::")) {
                                enumKey = key
                            } else if (enumKey != null) {
                                const [enumName, enumValue] = enumKey.split("::")
                                const [enumCase, enumIndex] = enumValue.split("#")
                                if (parseInt(enumIndex, 0) != 1) {
                                    return null
                                }
                                newPath.push({ enumName, enumCase, typeName: key })
                                typeName = key
                                enumKey = null
                            } else {
                                newPath.push(key)
                            }
                        }

                        return { [typeName]: newPath }
                    }

                    return null
                })
                .filter(x => x != null)
                .reduce((acc, cur) => Object.assign(acc, cur), {})
            if (paths == null || Object.keys(paths).length === 0) {
                return {}
            }
            return { [topKey]: paths }
        }).reduce((acc: Record<string, unknown>, cur) => {
            return Object.assign(acc, cur)
        })

        return paths as Paths
    }

    generate() {
        this.generateModels()
        this.generateCastFns()
    }
}

class AstParser {
    private readonly ast: Ast

    constructor(ast: Ast) {
        this.ast = ast
    }

    private parseStruct(structName: string, structFields: Record<string, unknown>): StructSpec {
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
    
    private parseEnumValueArray(array: unknown[]): CaseSpec {
        // Empty case
        if (array.length === 0) {
            return new CaseSpec([])
        }

        if (array.length === 1) {
            return new CaseSpec([
                new TypeSpec((array as string[])[0], true)
            ])
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

    private parseEnum(enumName: string, enumValues: unknown[]): EnumSpec {
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
        // Parse into models
        const models: TopLevelSpec[] = Object.entries(this.ast.models).map(([key, value]) => {
            const type = typeOf(value)
            
            if (type === JsType.String ) {
                return new TupleStructSpec(key, [new TypeSpec(value as string)])
            } else if (type === JsType.Object) {
                return this.parseStruct(key, value as Record<string, unknown>)
            } else if (type === JsType.Array) {
                if ((value as unknown[]).length === 1) {
                    return new TupleStructSpec(key, [
                        new TypeSpec((value as string[])[0], true)
                    ])
                }
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

    // console.log(JSON.stringify(models, null, 2))

    const generator = new RustGenerator(models)
    generator.generate()
}

// Run our program
main()
