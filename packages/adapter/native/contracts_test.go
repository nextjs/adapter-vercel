package main

// Expose native operations only from a Go test executable so the existing
// filesystem contract tests exercise the production Go helpers. The published
// adapter executable has no test dispatch or JavaScript output implementation.
import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	operation := os.Getenv("NEXT_ADAPTER_TEST_OPERATION")
	if operation == "" {
		os.Exit(m.Run())
	}
	result, failure := runContract(operation)
	if failure != nil {
		_ = json.NewEncoder(os.Stdout).Encode(object{"error": failure})
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(object{"result": result})
	os.Exit(0)
}

func runContract(operation string) (result any, failure object) {
	defer func() {
		if value := recover(); value != nil {
			failure = object{"message": fmt.Sprint(value)}
			if err, ok := value.(error); ok {
				if os.IsNotExist(err) {
					failure["code"] = "ENOENT"
				}
				if os.IsExist(err) {
					failure["code"] = "EEXIST"
				}
			}
		}
	}()
	var input struct {
		request
		OutputDir  string            `json:"outputDir"`
		Values     []any             `json:"values"`
		Params     object            `json:"params"`
		Parents    map[string]object `json:"parents"`
		Fallbacks  object            `json:"fallbacks"`
		Middleware bool              `json:"middleware"`
	}
	check(json.NewDecoder(os.Stdin).Decode(&input))
	if operation == "matchFunctionPatterns" {
		result := []bool{}
		for _, rule := range input.FunctionRules {
			matcher := compileFunctionMatcher(rule)
			for _, source := range input.Values {
				matched, err := matcher.match(str(source))
				check(err)
				result = append(result, str(source) == rule.Pattern || matched)
			}
		}
		return result, nil
	}
	if operation == "collectGoRouteOutputs" {
		return collectGoRouteOutputs(input.Outputs), nil
	}
	if operation == "usesSrcDirectory" {
		return usesSrcDirectory(str(input.Params["workPath"])), nil
	}
	if operation == "getSourceFilePathFromPage" {
		opts := input.Params
		allowFile, allowIndex := true, true
		if value, ok := opts["allowExtensionless"].(bool); ok {
			allowFile = value
		}
		if value, ok := opts["allowDirectoryIndex"].(bool); ok {
			allowIndex = value
		}
		return sourceFile(str(opts["workPath"]), str(opts["page"]), stringsFrom(opts["pageExtensions"]), stringsFrom(opts["pageTypes"]), flag(opts["usesSrcDir"]), allowFile, allowIndex), nil
	}
	a := newAdapter(input.request)
	defer a.workers.close()
	a.outputDir = input.OutputDir
	if input.Parents != nil {
		a.parents = input.Parents
	}
	if input.Fallbacks != nil {
		a.fallbacks = input.Fallbacks
	}
	switch operation {
	case "handleGoOutputs":
		collectGoRouteOutputs(object{"appRoutes": input.Values})
		a.goOutputs(input.Values)
	case "handleNodeOutputs":
		a.nodeOutputs(input.Values, input.Middleware)
	case "handlePrerenderOutputs":
		a.prerenders(input.Values)
	default:
		panic("Unknown native contract operation: " + operation)
	}
	return nil, nil
}
