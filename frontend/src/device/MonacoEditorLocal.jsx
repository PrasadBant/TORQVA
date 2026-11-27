import React from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';

// Use the installed, version-pinned Monaco bundle. No CDN request and no source
// code leaves TORQVA merely by opening the Development workspace.
loader.config({ monaco });

export default function MonacoEditorLocal(props) {
  return <Editor {...props} />;
}
