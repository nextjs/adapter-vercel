package main

// These fields do not vary between functions of the same operation type.
// Encode them once instead of rebuilding and reflecting over a map per output.
type nodeFunctionConfig struct {
	OperationType string `json:"operationType"`
	Framework     struct {
		Slug    string `json:"slug"`
		Version string `json:"version"`
	} `json:"framework"`
	Handler                     string `json:"handler"`
	Runtime                     string `json:"runtime"`
	SupportsMultiPayloads       bool   `json:"supportsMultiPayloads"`
	SupportsResponseStreaming   bool   `json:"supportsResponseStreaming"`
	ExperimentalAllowBundling   bool   `json:"experimentalAllowBundling"`
	DisableFetchInstrumentation bool   `json:"shouldDisableAutomaticFetchInstrumentation"`
	LauncherType                string `json:"launcherType"`
	UseWebAPI                   bool   `json:"useWebApi,omitempty"`
}

func nodeConfigPrefix(base string, options object, middleware, hasHashes bool) string {
	for _, name := range [...]string{"operationType", "framework", "handler", "runtime", "supportsMultiPayloads", "supportsResponseStreaming", "experimentalAllowBundling", "shouldDisableAutomaticFetchInstrumentation", "launcherType", "filePathMap"} {
		delete(options, name)
	}
	if middleware {
		delete(options, "useWebApi")
	}
	if hasHashes {
		delete(options, "fileHashes")
	}
	if len(options) == 0 {
		return base
	}
	extra := jsonText(options)
	return base[:len(base)-1] + "," + extra[1:]
}
