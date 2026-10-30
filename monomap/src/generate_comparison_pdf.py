"""
Generate executive PDF report comparing Model 1 and Model 8 in Downloads.
"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether, HRFlowable, PageBreak
)
from reportlab.pdfgen import canvas

PDF_OUTPUT_PATH = r"C:\Users\Atharv\Downloads\3D_Reconstruction_Model1_vs_Model8_Analysis.pdf"

class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super(NumberedCanvas, self).__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super(NumberedCanvas, self).showPage()
        super(NumberedCanvas, self).save()

    def draw_page_decorations(self, page_count):
        self.saveState()
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#64748b"))
        
        # Header rule & title
        self.setStrokeColor(colors.HexColor("#e2e8f0"))
        self.setLineWidth(0.75)
        self.line(40, letter[1] - 30, letter[0] - 40, letter[1] - 30)
        self.drawString(40, letter[1] - 25, "Namma Space · 3D Spatial Intelligence & Navigation")
        self.drawRightString(letter[0] - 40, letter[1] - 25, "Technical Model Analysis: Model 1 vs Model 8")

        # Footer rule & page
        self.line(40, 35, letter[0] - 40, 35)
        self.drawString(40, 22, "Techfest 2026 · Confidential & Proprietary Technical Report")
        self.drawRightString(letter[0] - 40, 22, f"Page {self._pageNumber} of {page_count}")
        self.restoreState()

def build_pdf():
    doc = SimpleDocTemplate(
        PDF_OUTPUT_PATH,
        pagesize=letter,
        leftMargin=40,
        rightMargin=40,
        topMargin=46,
        bottomMargin=46
    )

    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=4
    )
    
    subtitle_style = ParagraphStyle(
        'DocSubtitle',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=10.5,
        leading=15,
        textColor=colors.HexColor("#475569"),
        spaceAfter=12
    )
    
    meta_style = ParagraphStyle(
        'MetaStyle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=8.5,
        leading=12,
        textColor=colors.HexColor("#0284c7")
    )

    h1_style = ParagraphStyle(
        'Heading1Custom',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=13,
        leading=17,
        textColor=colors.HexColor("#0f172a"),
        spaceBefore=10,
        spaceAfter=6
    )

    h2_style = ParagraphStyle(
        'Heading2Custom',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=10.5,
        leading=14,
        textColor=colors.HexColor("#0369a1"),
        spaceBefore=6,
        spaceAfter=3
    )

    body_style = ParagraphStyle(
        'BodyCustom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9.5,
        leading=13.5,
        textColor=colors.HexColor("#1e293b"),
        spaceAfter=5
    )

    bullet_style = ParagraphStyle(
        'BulletCustom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#1e293b"),
        leftIndent=14,
        firstLineIndent=-10,
        spaceAfter=3
    )

    formula_style = ParagraphStyle(
        'FormulaCustom',
        parent=styles['Normal'],
        fontName='Courier',
        fontSize=9.5,
        leading=13,
        textColor=colors.HexColor("#0f172a"),
        alignment=1
    )

    table_header_style = ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#ffffff")
    )

    table_cell_style = ParagraphStyle(
        'TableCell',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=11.5,
        textColor=colors.HexColor("#1e293b")
    )

    table_cell_bold = ParagraphStyle(
        'TableCellBold',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=8.5,
        leading=11.5,
        textColor=colors.HexColor("#0f172a")
    )

    story = []

    # Title Banner
    story.append(Paragraph("TECHNICAL RECONSTRUCTION REPORT", meta_style))
    story.append(Spacer(1, 2))
    story.append(Paragraph("3D Reconstruction Model Analysis: Model 1 vs Model 8", title_style))
    story.append(Paragraph(
        "A deep architectural and geometric breakdown of the two premier monocular 3D representations: "
        "<b>Model 1 (Dense Metric RGB-D Point Cloud)</b> and <b>Model 8 (LingBot-Map GCT Neural Feature Cloud)</b>.",
        subtitle_style
    ))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#cbd5e1"), spaceAfter=10))

    # SECTION 1: MODEL 1
    m1_banner = Table(
        [[Paragraph("<b>🌟 MODEL 1: Dense Metric RGB-D Point Cloud</b>", ParagraphStyle('M1Title', fontName='Helvetica-Bold', fontSize=11, leading=14, textColor=colors.HexColor("#0369a1")))]],
        colWidths=[532],
        style=TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#f0f9ff")),
            ('BOX', (0,0), (-1,-1), 1, colors.HexColor("#bae6fd")),
            ('TOPPADDING', (0,0), (-1,-1), 6),
            ('BOTTOMPADDING', (0,0), (-1,-1), 6),
            ('LEFTPADDING', (0,0), (-1,-1), 10),
            ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ])
    )
    story.append(m1_banner)
    story.append(Spacer(1, 6))

    story.append(Paragraph("<b>What It Is</b>", h2_style))
    story.append(Paragraph(
        "Direct neural back-projection of the smartphone video into <b>1.8+ million scale-consistent 3D points</b> without polygon meshing. "
        "It preserves 100% of the true physical visual evidence captured by the camera sensor.",
        body_style
    ))

    story.append(Paragraph("<b>How It Works</b>", h2_style))
    story.append(Paragraph(
        "<b>1. Metric Depth Foundation:</b> Every video frame is passed through <i>Depth-Anything-V2 (Indoor Metric)</i>, a deep Vision Transformer (ViT) that predicts scale-consistent millimeter distances directly for every pixel.",
        bullet_style
    ))
    story.append(Paragraph(
        "<b>2. Multi-View Camera Odometry:</b> RGB-D feature tracking and frame-to-frame trajectory estimation register camera poses in real metric 3D space.",
        bullet_style
    ))
    story.append(Paragraph(
        "<b>3. Pinhole Back-Projection:</b> Each 2D pixel coordinate (<i>u, v</i>) with depth <i>z</i> is mapped into 3D world coordinates (<i>X, Y, Z</i>):",
        bullet_style
    ))

    # Math Box
    math_box = Table(
        [[
            Paragraph("<b>X = (u - c<sub>x</sub>) · z / f<sub>x</sub></b>", formula_style),
            Paragraph("<b>Y = (v - c<sub>y</sub>) · z / f<sub>y</sub></b>", formula_style),
            Paragraph("<b>Z = z</b>", formula_style)
        ]],
        colWidths=[170, 170, 160],
        style=TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#f8fafc")),
            ('BOX', (0,0), (-1,-1), 0.75, colors.HexColor("#cbd5e1")),
            ('ALIGN', (0,0), (-1,-1), 'CENTER'),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('TOPPADDING', (0,0), (-1,-1), 5),
            ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ])
    )
    story.append(Spacer(1, 2))
    story.append(math_box)
    story.append(Spacer(1, 4))

    story.append(Paragraph(
        "<b>4. Statistical Outlier Denoising:</b> A KD-Tree Statistical Outlier Removal (SOR) filter evaluates the mean neighbor distance (k=30, std_ratio=1.2) to eliminate transient reflections, dust, and floating artifacts.",
        bullet_style
    ))

    story.append(Paragraph("<b>Why It Looks So Good</b>", h2_style))
    story.append(Paragraph(
        "• <b>Zero Polygon Distortion:</b> Traditional surface meshing (such as unconstrained Poisson) attempts to close open scans into watertight solids, causing the notorious melted wax / cave effect. Model 1 avoids that entirely by preserving true discrete samples.",
        bullet_style
    ))
    story.append(Paragraph(
        "• <b>Crisp Camera RGB:</b> Each 3D point retains the exact native color from the smartphone camera sensor, eliminating blurry Gaussian splat artifacts or interpolated texture stretching.",
        bullet_style
    ))

    story.append(Spacer(1, 14))
    
    # Key Takeaway Box for Model 1
    m1_takeaway = Table(
        [[
            Paragraph("<b>Key Engineering Takeaway (Model 1):</b> By unprojecting directly from calibrated neural metric depth into point space, we retain 100% geometric truth without topological assumptions. This is the optimal mode for high-fidelity human teleoperation, visual inspection, and ground-truth 3D point cloud generation.", ParagraphStyle('TakeawayStyle', fontName='Helvetica', fontSize=8.5, leading=12, textColor=colors.HexColor("#0369a1")))
        ]],
        colWidths=[532],
        style=TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#f8fafc")),
            ('BOX', (0,0), (-1,-1), 0.75, colors.HexColor("#bae6fd")),
            ('TOPPADDING', (0,0), (-1,-1), 8),
            ('BOTTOMPADDING', (0,0), (-1,-1), 8),
            ('LEFTPADDING', (0,0), (-1,-1), 12),
            ('RIGHTPADDING', (0,0), (-1,-1), 12),
        ])
    )
    story.append(m1_takeaway)

    # PAGE BREAK TO START MODEL 8 ON PAGE 2 CLEANLY
    story.append(PageBreak())

    # SECTION 2: MODEL 8
    m8_banner = Table(
        [[Paragraph("<b>🧠 MODEL 8: LingBot-Map GCT Neural Feature Cloud</b>", ParagraphStyle('M8Title', fontName='Helvetica-Bold', fontSize=11, leading=14, textColor=colors.HexColor("#4338ca")))]],
        colWidths=[532],
        style=TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#eef2ff")),
            ('BOX', (0,0), (-1,-1), 1, colors.HexColor("#c7d2fe")),
            ('TOPPADDING', (0,0), (-1,-1), 6),
            ('BOTTOMPADDING', (0,0), (-1,-1), 6),
            ('LEFTPADDING', (0,0), (-1,-1), 10),
            ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ])
    )
    story.append(m8_banner)
    story.append(Spacer(1, 6))

    story.append(Paragraph("<b>What It Is</b>", h2_style))
    story.append(Paragraph(
        "A feed-forward 3D foundation model output using the <b>Geometric Context Transformer (GCT)</b> architecture (lingbot-map.pt, 4.63 GB weights). "
        "It integrates streaming video frames with trajectory memory and surface normal curvature feature highlighting.",
        body_style
    ))

    story.append(Paragraph("<b>How It Works</b>", h2_style))
    story.append(Paragraph(
        "<b>1. Geometric Context Attention:</b> Rather than estimating frames in isolation, LingBot-Map's transformer architecture unifies coordinate grounding, dense geometric cues, and long-range drift correction through an anchor context, pose-reference window, and trajectory memory with paged KV caching.",
        bullet_style
    ))
    story.append(Paragraph(
        "<b>2. Surface Normal Curvature Tensor Encoding:</b> Instead of flat uniform colors, each 3D point is rendered with local geometric curvature derived from surface normals:",
        bullet_style
    ))
    story.append(Paragraph(
        "&nbsp;&nbsp;&nbsp;&nbsp;• <b>Blue / Cyan Gradients:</b> Flat, smooth planar structures such as the floor and workbench tops.",
        bullet_style
    ))
    story.append(Paragraph(
        "&nbsp;&nbsp;&nbsp;&nbsp;• <b>Amber / Red Highlights:</b> High-curvature architectural edges, corrugated wall seams, vertical columns, and machine boundaries.",
        bullet_style
    ))

    story.append(Paragraph("<b>Why It Looks So Good</b>", h2_style))
    story.append(Paragraph(
        "• <b>Structural Legibility:</b> Architectural edges and boundaries instantly 'pop'. The human eye or navigation planner can immediately distinguish where walls meet the ceiling, where machine edges end, and where the floor plane lies.",
        bullet_style
    ))
    story.append(Paragraph(
        "• <b>Robotic Feature Extraction:</b> This representation is natively optimized for autonomous spatial intelligence, obstacle boundary detection, and LiDAR-like perception.",
        bullet_style
    ))

    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", thickness=0.75, color=colors.HexColor("#e2e8f0"), spaceAfter=8))

    # SECTION 3: COMPARISON TABLE
    story.append(Paragraph("<b>📊 Summary Comparison Matrix</b>", h1_style))
    story.append(Spacer(1, 3))

    table_data = [
        [
            Paragraph("<b>Feature Dimension</b>", table_header_style),
            Paragraph("<b>Model 1: Dense Metric Point Cloud</b>", table_header_style),
            Paragraph("<b>Model 8: LingBot-Map GCT</b>", table_header_style)
        ],
        [
            Paragraph("<b>Look & Feel</b>", table_cell_bold),
            Paragraph("Photorealistic real-world replica; exact camera pixels and textures.", table_cell_style),
            Paragraph("'Robotic LiDAR / Architectural CAD' view; crisp structural boundaries.", table_cell_style)
        ],
        [
            Paragraph("<b>Coloring Mode</b>", table_cell_bold),
            Paragraph("100% natural phone RGB sensor colors.", table_cell_style),
            Paragraph("Surface normal curvature & geometric edge gradients.", table_cell_style)
        ],
        [
            Paragraph("<b>Primary Application</b>", table_cell_bold),
            Paragraph("Human inspection, digital twin archiving, VR walkthroughs, photorealistic viewing.", table_cell_style),
            Paragraph("Autonomous edge detection, obstacle collision bounding, robot trajectory planning.", table_cell_style)
        ],
        [
            Paragraph("<b>Computation Engine</b>", table_cell_bold),
            Paragraph("Depth-Anything-V2 Metric (ViT) + Multi-View RGB-D Fusion.", table_cell_style),
            Paragraph("Geometric Context Transformer (GCT, 4.63 GB Foundation Model).", table_cell_style)
        ]
    ]

    comp_table = Table(
        table_data,
        colWidths=[112, 210, 210],
        style=TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#0f172a")),
            ('TEXTCOLOR', (0,0), (-1,0), colors.whitesmoke),
            ('ALIGN', (0,0), (-1,-1), 'LEFT'),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('TOPPADDING', (0,0), (-1,-1), 6),
            ('BOTTOMPADDING', (0,0), (-1,-1), 6),
            ('LEFTPADDING', (0,0), (-1,-1), 8),
            ('RIGHTPADDING', (0,0), (-1,-1), 8),
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor("#ffffff"), colors.HexColor("#f8fafc")]),
        ])
    )
    story.append(comp_table)

    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"PDF Successfully generated at: {PDF_OUTPUT_PATH}")

if __name__ == "__main__":
    build_pdf()
