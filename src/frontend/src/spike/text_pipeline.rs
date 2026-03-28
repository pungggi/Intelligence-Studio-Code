//! Text Rendering Pipeline - wgpu render pipeline for drawing text quads.
//!
//! Each visible character becomes a textured quad (2 triangles, 6 vertices).
//! The vertex buffer is rebuilt each frame for visible lines only.

use super::glyph_atlas::GlyphAtlas;
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct Vertex {
    position: [f32; 2],
    tex_coords: [f32; 2],
    color: [f32; 4],
}

impl Vertex {
    fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 16,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Float32x4,
                },
            ],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct Uniforms {
    screen_size: [f32; 2],
    _padding: [f32; 2],
}

const SHADER_SOURCE: &str = r#"
struct Uniforms {
    screen_size: vec2<f32>,
    _padding: vec2<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var atlas_texture: texture_2d<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // Convert pixel coordinates to clip space (-1..1)
    let ndc_x = (in.position.x / uniforms.screen_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (in.position.y / uniforms.screen_size.y) * 2.0;
    out.clip_position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.tex_coords = in.tex_coords;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let tex_color = textureSample(atlas_texture, atlas_sampler, in.tex_coords);
    return vec4<f32>(in.color.rgb, in.color.a * tex_color.a);
}
"#;

/// Maximum number of characters we can render per frame.
/// 200 visible lines * 120 chars = 24,000 quads * 6 vertices = 144,000 vertices
const MAX_VERTICES: usize = 150_000;

pub struct TextPipeline {
    pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
    uniform_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    vertex_count: u32,
}

impl TextPipeline {
    pub fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        atlas_texture: &wgpu::Texture,
        _width: u32,
        _height: u32,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Text Shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE.into()),
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Uniform Buffer"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let atlas_view = atlas_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let atlas_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Atlas Sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Text Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Text Bind Group"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&atlas_sampler),
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Text Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Text Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[Vertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Text Vertex Buffer"),
            size: (MAX_VERTICES * std::mem::size_of::<Vertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            vertex_buffer,
            uniform_buffer,
            bind_group,
            vertex_count: 0,
        }
    }

    pub fn resize(&mut self, queue: &wgpu::Queue, width: u32, height: u32) {
        let uniforms = Uniforms {
            screen_size: [width as f32, height as f32],
            _padding: [0.0; 2],
        };
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));
    }

    /// Build vertex data for visible lines and upload to GPU.
    pub fn prepare_lines(
        &mut self,
        _device: &wgpu::Device,
        queue: &wgpu::Queue,
        atlas: &GlyphAtlas,
        lines: &[String],
        y_start: f32,
        screen_width: f32,
        screen_height: f32,
    ) {
        // Update uniforms
        let uniforms = Uniforms {
            screen_size: [screen_width, screen_height],
            _padding: [0.0; 2],
        };
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let mut vertices: Vec<Vertex> = Vec::with_capacity(lines.len() * 80 * 6);
        let line_height = atlas.line_height();
        let cell_width = atlas.cell_width();

        let left_padding = 8.0;

        for (line_idx, line) in lines.iter().enumerate() {
            let y = y_start + (line_idx as f32) * line_height;

            // Skip lines that are fully off-screen
            if y + line_height < 0.0 || y > screen_height {
                continue;
            }

            // Determine line color based on content (simple syntax-like coloring)
            let base_color = line_color(line);

            for (char_idx, ch) in line.chars().enumerate() {
                if ch == ' ' || ch == '\t' {
                    continue;
                }

                let glyph = atlas.get_glyph(ch);
                let x = left_padding + (char_idx as f32) * cell_width + glyph.x_offset;
                let gy = y + line_height - glyph.height as f32 + glyph.y_offset;

                // Skip glyphs outside horizontal view
                if x > screen_width || x + (glyph.width as f32) < 0.0 {
                    continue;
                }

                let color = char_color(ch, &base_color);

                let w = glyph.width as f32;
                let h = glyph.height as f32;

                // Two triangles for the quad
                // Triangle 1: top-left, top-right, bottom-left
                vertices.push(Vertex {
                    position: [x, gy],
                    tex_coords: [glyph.uv_x, glyph.uv_y],
                    color,
                });
                vertices.push(Vertex {
                    position: [x + w, gy],
                    tex_coords: [glyph.uv_x + glyph.uv_w, glyph.uv_y],
                    color,
                });
                vertices.push(Vertex {
                    position: [x, gy + h],
                    tex_coords: [glyph.uv_x, glyph.uv_y + glyph.uv_h],
                    color,
                });

                // Triangle 2: top-right, bottom-right, bottom-left
                vertices.push(Vertex {
                    position: [x + w, gy],
                    tex_coords: [glyph.uv_x + glyph.uv_w, glyph.uv_y],
                    color,
                });
                vertices.push(Vertex {
                    position: [x + w, gy + h],
                    tex_coords: [glyph.uv_x + glyph.uv_w, glyph.uv_y + glyph.uv_h],
                    color,
                });
                vertices.push(Vertex {
                    position: [x, gy + h],
                    tex_coords: [glyph.uv_x, glyph.uv_y + glyph.uv_h],
                    color,
                });

                if vertices.len() >= MAX_VERTICES - 6 {
                    break;
                }
            }

            if vertices.len() >= MAX_VERTICES - 6 {
                break;
            }
        }

        self.vertex_count = vertices.len() as u32;
        if !vertices.is_empty() {
            queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&vertices));
        }
    }

    pub fn render<'a>(&'a self, render_pass: &mut wgpu::RenderPass<'a>) {
        if self.vertex_count == 0 {
            return;
        }
        render_pass.set_pipeline(&self.pipeline);
        render_pass.set_bind_group(0, &self.bind_group, &[]);
        render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
        render_pass.draw(0..self.vertex_count, 0..1);
    }
}

/// Simple syntax-like coloring based on line content.
fn line_color(line: &str) -> [f32; 4] {
    let trimmed = line.trim_start();
    // After the "NNNN | " prefix
    let content = if let Some(idx) = trimmed.find("| ") {
        &trimmed[idx + 2..]
    } else {
        trimmed
    };

    if content.starts_with("//") || content.starts_with("///") {
        // Comments: green
        [0.45, 0.7, 0.45, 1.0]
    } else if content.starts_with("fn ")
        || content.starts_with("pub ")
        || content.starts_with("impl")
        || content.starts_with("struct ")
        || content.starts_with("const ")
        || content.starts_with("use ")
    {
        // Keywords: blue
        [0.5, 0.6, 0.9, 1.0]
    } else if content.starts_with("let ") || content.starts_with("if ") {
        // Variables/control: orange
        [0.9, 0.7, 0.4, 1.0]
    } else {
        // Default: light grey
        [0.85, 0.85, 0.85, 1.0]
    }
}

/// Per-character color adjustments.
fn char_color(ch: char, base: &[f32; 4]) -> [f32; 4] {
    match ch {
        // Punctuation: dimmer
        '{' | '}' | '(' | ')' | '[' | ']' | ';' | ',' | '.' | ':' => {
            [base[0] * 0.6, base[1] * 0.6, base[2] * 0.6, base[3]]
        }
        // Line numbers and pipe: very dim
        '|' => [0.35, 0.35, 0.40, 1.0],
        '0'..='9' if base[0] > 0.8 => [0.4, 0.4, 0.45, 1.0],
        _ => *base,
    }
}
