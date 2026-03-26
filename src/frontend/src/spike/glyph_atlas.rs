//! Glyph Atlas - CPU-side font rasterization and GPU texture atlas.
//!
//! Uses `fontdue` to rasterize a monospaced font into a texture atlas,
//! which is then uploaded to the GPU for use in the text rendering pipeline.

use fontdue::{Font, FontSettings};
use std::collections::HashMap;

/// A single glyph's metrics and position in the atlas texture.
#[derive(Clone, Copy, Debug)]
pub struct GlyphInfo {
    /// UV coordinates in the atlas (normalized 0..1)
    pub uv_x: f32,
    pub uv_y: f32,
    pub uv_w: f32,
    pub uv_h: f32,
    /// Pixel dimensions
    pub width: u32,
    pub height: u32,
    /// Horizontal offset from cursor position
    pub x_offset: f32,
    /// Vertical offset from baseline
    pub y_offset: f32,
    /// How far to advance the cursor
    pub advance: f32,
}

pub struct GlyphAtlas {
    font: Font,
    font_size: f32,
    glyphs: HashMap<char, GlyphInfo>,
    atlas_width: u32,
    atlas_height: u32,
    atlas_data: Vec<u8>,
    cell_width: f32,
    cell_height: f32,
}

impl GlyphAtlas {
    pub fn new(font_size: f32) -> Self {
        // Use a built-in monospaced font approximation.
        // In production, load JetBrains Mono or similar.
        let font_data = include_bytes!("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf");
        let font = Font::from_bytes(
            font_data as &[u8],
            FontSettings {
                scale: font_size,
                ..FontSettings::default()
            },
        )
        .expect("Failed to load font");

        // Calculate cell dimensions from a reference character
        let (metrics, _) = font.rasterize('M', font_size);
        let cell_width = metrics.advance_width.ceil();
        let cell_height = (font_size * 1.5).ceil();

        Self {
            font,
            font_size,
            glyphs: HashMap::new(),
            atlas_width: 0,
            atlas_height: 0,
            atlas_data: Vec::new(),
            cell_width,
            cell_height,
        }
    }

    /// Build the atlas texture and upload to GPU.
    pub fn build_atlas_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> wgpu::Texture {
        // Rasterize printable ASCII range
        let chars: Vec<char> = (32u8..=126).map(|c| c as char).collect();
        let char_count = chars.len();

        // Grid layout: ~16 chars per row
        let cols = 16u32;
        let rows = ((char_count as u32) + cols - 1) / cols;

        // Each cell is padded
        let cell_w = (self.cell_width as u32).max(1) + 2;
        let cell_h = (self.cell_height as u32).max(1) + 2;

        self.atlas_width = cols * cell_w;
        self.atlas_height = rows * cell_h;

        // RGBA atlas (white text, varying alpha)
        self.atlas_data = vec![0u8; (self.atlas_width * self.atlas_height * 4) as usize];

        for (i, &ch) in chars.iter().enumerate() {
            let (metrics, bitmap) = self.font.rasterize(ch, self.font_size);

            let col = (i as u32) % cols;
            let row = (i as u32) / cols;
            let base_x = col * cell_w + 1;
            let base_y = row * cell_h + 1;

            // Copy glyph bitmap into atlas (as white with alpha)
            for gy in 0..metrics.height {
                for gx in 0..metrics.width {
                    let atlas_x = base_x + gx as u32;
                    let atlas_y = base_y + gy as u32;

                    if atlas_x < self.atlas_width && atlas_y < self.atlas_height {
                        let atlas_idx =
                            ((atlas_y * self.atlas_width + atlas_x) * 4) as usize;
                        let alpha = bitmap[gy * metrics.width + gx];
                        self.atlas_data[atlas_idx] = 255; // R
                        self.atlas_data[atlas_idx + 1] = 255; // G
                        self.atlas_data[atlas_idx + 2] = 255; // B
                        self.atlas_data[atlas_idx + 3] = alpha; // A
                    }
                }
            }

            let glyph_info = GlyphInfo {
                uv_x: base_x as f32 / self.atlas_width as f32,
                uv_y: base_y as f32 / self.atlas_height as f32,
                uv_w: metrics.width as f32 / self.atlas_width as f32,
                uv_h: metrics.height as f32 / self.atlas_height as f32,
                width: metrics.width as u32,
                height: metrics.height as u32,
                x_offset: metrics.xmin as f32,
                y_offset: metrics.ymin as f32,
                advance: metrics.advance_width,
            };

            self.glyphs.insert(ch, glyph_info);
        }

        println!(
            "[GlyphAtlas] Built {}x{} atlas with {} glyphs, cell={}x{}",
            self.atlas_width,
            self.atlas_height,
            self.glyphs.len(),
            cell_w,
            cell_h
        );

        // Upload to GPU
        let texture_size = wgpu::Extent3d {
            width: self.atlas_width,
            height: self.atlas_height,
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Glyph Atlas"),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &self.atlas_data,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(4 * self.atlas_width),
                rows_per_image: Some(self.atlas_height),
            },
            texture_size,
        );

        texture
    }

    /// Look up glyph info for a character. Falls back to '?' for unknown chars.
    pub fn get_glyph(&self, ch: char) -> &GlyphInfo {
        self.glyphs
            .get(&ch)
            .or_else(|| self.glyphs.get(&'?'))
            .expect("Atlas missing fallback glyph '?'")
    }

    /// Monospace cell width in pixels.
    pub fn cell_width(&self) -> f32 {
        self.cell_width
    }

    /// Line height in pixels.
    pub fn line_height(&self) -> f32 {
        self.cell_height
    }
}
