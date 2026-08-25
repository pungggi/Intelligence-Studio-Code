; TOML highlights query
; Minimal query demonstrating the grammar-provider API.

(comment) @comment

(bare_key) @property
(quoted_key) @property
(dotted_key) @property

(string) @string
(integer) @number
(float) @number
(boolean) @constant

(table
  (bare_key) @type)
(table_array_element
  (bare_key) @type)

["[" "]" "[[" "]]"] @punctuation
["=" "."] @operator
