---
"@next-community/adapter-vercel": minor
---

Use version 2 of the hosted Go packager contract, allowing the packager to choose container or executable packaging for each output. Go route handlers become container functions, while `proxy.go` middleware stays executable according to the packager result. Containers use an image handler and optional staged OCI layout; executables include the launcher, user server, and assets. Separate assets on container outputs must be embedded with `go:embed`. Version 1 packagers are no longer supported, and an optional close hook releases build resources.
