# Build system guide

The Development/Build workspaces use the existing restricted Docker PlatformIO compiler. Uploaded archives are size-, path- and type-validated; builds do not receive device access, signing keys or a privileged Docker socket. When Docker or the prepared image is unavailable, the UI reports infrastructure unavailable. Build completion never deploys automatically unless an existing explicitly authorized workflow requests it.
