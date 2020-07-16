// Import the yaml library, installed from npm
const yaml = require("js-yaml")

// Import the fs library, built into node.js's standard library
const fs = require("fs")

function typeOf(value) {
    if (value === null) {
        return "null"
    }

    if (Array.isArray(value)) {
        return "array"
    }

    return typeof value
}

function generateStruct(structName, fields) {
    let s = `pub(crate) struct ${structName} {\n`

    for (const [fieldName, fieldValue] of Object.entries(fields)) {
        const type = typeOf(fieldValue)

        if (type === "array") {
            s += `    ${fieldName}: Vec<${fieldValue[0]}>,\n`
        } else if (type === "string") {
            s += `    ${fieldName}: ${fieldValue},\n`
        } else {
            throw new Error(`Unhandled type: ${type}`)
        }
    }

    s += "}\n"

    console.log(s)
}

function generateEnum(enumName, enumValues) {
    let s = `pub(crate) enum ${enumName} {\n`

    for (const value of enumValues) {
        const type = typeOf(value)

        if (type === "string") {
            // This is self referencing!! WOWEE
            s += `    ${value}(${value}),\n`
        } else if (type === "object") {
            // This is a tuple of operands
            // s += `    ${value}(,.....),\n`
            const [key, innerTypeObj] = Object.entries(value)[0]
            const innerType = typeOf(innerTypeObj)

            if (innerType === "string") {
                s += `    ${key}(${innerTypeObj}),\n`
            } else if (innerType === "array") {
                if (innerTypeObj.length === 0) {
                    s += `    ${key},\n`
                } else {
                    s += `    ${key}(`
                    for (const nestedTypeObj of innerTypeObj) {
                        const nestedType = typeOf(nestedTypeObj)
    
                        if (nestedType === "array") {
                            // This is our empty case
                            s += `Vec<${nestedTypeObj[0]}>, `
                        } else if (nestedType === "string") {
                            s += `${nestedTypeObj}, `
                        } else {
                            throw new Error(`Unknown type: ${nestedType}`)
                        }
    
                        // console.log("~~~~~", nestedTypeObj, nestedType)
                    }
                    s = s.slice(0, s.length - 2)

                    s += `),\n`
                }

            } else {
                throw new Error(`Unknown type: ${type}`)
            }
            
            // console.log('~~~~~', key, innerTypeObj, innerType)
        } else {
            throw new Error(type)
            console.log(value, type)
        }
    }

    s += "}\n"

    console.log(s)
}

/// This function does
function main() {
    // Read the ast.yaml file from the current directory as a string
    const yamlData = fs.readFileSync("./ast.yaml", "utf8")

    // Parse the YAML string into a JavaScript object
    const obj = yaml.safeLoad(yamlData)


    for (const [key, value] of Object.entries(obj.models)) {
        const type = typeOf(value)
        
        if (type === "string") {
            console.log(`pub(crate) struct ${key}(pub(crate) ${value});\n`)
        } else if (type === "object") {
            generateStruct(key, value)
        } else if (type === "array") {
            generateEnum(key, value)
        } else {
            console.log(`Warning: Unhandled type for key "${key}": ${type}`)
        }
    }
}

// Run our programs
main()

// Rust:
// enum CardinalDirections { North, South, East, West }
// enum Shape { Square(width, height), Circle(Foo) }
// struct Foo {
//   bar: String,
//   oaisjdoij: Shape
//}

// Input -> Identifier: 'string'
// Output -> struct Identifier(String)